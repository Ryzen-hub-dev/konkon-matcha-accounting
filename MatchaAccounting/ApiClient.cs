using System;
using System.Net;
using Newtonsoft.Json;
using System.Text;
using System.Threading.Tasks;
using System.Net.Http;

namespace MatchaAccounting
{
    public class ApiClient
    {
        private readonly HttpClient _httpClient;

        public ApiClient()
        {
            var handler = new HttpClientHandler();
            handler.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            handler.UseCookies = false;

            _httpClient = new HttpClient(handler);
            _httpClient.BaseAddress = new Uri(ApiConfig.ApiBaseUrl);
            _httpClient.Timeout = TimeSpan.FromSeconds(ApiConfig.ApiTimeoutSeconds);
            _httpClient.DefaultRequestHeaders.Add("Accept", "application/json");
            _httpClient.DefaultRequestHeaders.Add("X-Requested-With", "XMLHttpRequest");
            _httpClient.DefaultRequestHeaders.Add("User-Agent", "MatchaAccounting Desktop Client");
        }

        public async Task<T> GetAsync<T>(string relativeUrl)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, relativeUrl))
            {
                return await SendAsync<T>(request);
            }
        }

        public async Task<T> PostAsync<T>(string relativeUrl, object body)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Post, relativeUrl))
            {
                request.Content = JsonContent(body);
                return await SendAsync<T>(request);
            }
        }

        public Task<ApiResponse<AuthResult>> LoginAsync(string username, string password)
        {
            return PostAsync<ApiResponse<AuthResult>>("api/login.php", new LoginRequest { Username = username, Password = password });
        }

        public async Task LogoutAsync()
        {
            if (!SessionManager.IsAuthenticated)
            {
                return;
            }

            try
            {
                string token = SessionManager.Current == null ? null : SessionManager.Current.AccessToken;
                SetBearerToken(token);
                await PostAsync<object>("api/logout.php", new { });
            }
            catch
            {
            }
        }

        public void SetBearerToken(string token)
        {
            _httpClient.DefaultRequestHeaders.Authorization = null;
            if (!string.IsNullOrWhiteSpace(token))
            {
                _httpClient.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            }
        }

        private async Task<T> SendAsync<T>(HttpRequestMessage request)
        {
            using (var response = await _httpClient.SendAsync(request))
            {
                string raw = await response.Content.ReadAsStringAsync();
                string contentType = "";
                if (response.Content != null && response.Content.Headers != null && response.Content.Headers.ContentType != null && !string.IsNullOrEmpty(response.Content.Headers.ContentType.MediaType))
                {
                    contentType = response.Content.Headers.ContentType.MediaType.ToLowerInvariant();
                }

                if (!string.IsNullOrWhiteSpace(contentType) &&
                    contentType.IndexOf("text/html", StringComparison.OrdinalIgnoreCase) >= 0 &&
                    raw.IndexOf("This site requires Javascript", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    throw new InvalidOperationException("请求被拦截为网页挑战页（Cloudflare/安全保护）。请先关闭站点JS挑战或设置API子域/路径豁免。原始返回为HTML。");
                }

                if (!response.IsSuccessStatusCode)
                {
                    throw new InvalidOperationException("API Error " + ((int)response.StatusCode).ToString() + ": " + response.ReasonPhrase + ". Response: " + raw);
                }

                try
                {
                    return JsonConvert.DeserializeObject<T>(raw);
                }
                catch (JsonException ex)
                {
                    int max = Math.Min(raw.Length, 200);
                    string preview = raw.Substring(0, max);
                    throw new InvalidOperationException("Invalid JSON from server: " + preview, ex);
                }
            }
        }

        private static StringContent JsonContent(object body)
        {
            string payload = JsonConvert.SerializeObject(body);
            return new StringContent(payload, Encoding.UTF8, "application/json");
        }
    }
}
