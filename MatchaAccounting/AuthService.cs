using Newtonsoft.Json;
using System;

namespace MatchaAccounting
{
    public sealed class AuthService
    {
        private readonly ApiClient _apiClient;

        public AuthService(ApiClient apiClient)
        {
            _apiClient = apiClient;
        }

        public async System.Threading.Tasks.Task<bool> LoginAsync(string username, string password)
        {
            try
            {
                var response = await _apiClient.LoginAsync(
                    username == null ? null : username.Trim(),
                    password
                );

                if (response == null || response.Success == false || response.Data == null)
                {
                    return false;
                }

                DateTimeOffset expiresAt;
                if (response.Data.ExpiresInSeconds > 0)
                {
                    expiresAt = DateTimeOffset.UtcNow.AddSeconds(response.Data.ExpiresInSeconds);
                }
                else
                {
                    expiresAt = DateTimeOffset.UtcNow.AddHours(8);
                }

                var session = new AuthSession
                {
                    AccessToken = response.Data.AccessToken,
                    RefreshToken = response.Data.RefreshToken,
                    User = response.Data.User,
                    ExpiresAtUtc = expiresAt,
                    Permissions = response.Data.Permissions
                };

                SessionManager.SetSession(session);
                _apiClient.SetBearerToken(session.AccessToken);
                return true;
            }
            catch (System.Net.Http.HttpRequestException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        public void Logout()
        {
            SessionManager.Clear();
        }

        public static UserProfile GetCurrentUser()
        {
            if (SessionManager.Current == null)
            {
                return null;
            }
            return SessionManager.Current.User;
        }
    }
}
