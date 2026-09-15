namespace KonkonMatcha.Client;

public static class ServiceEndpoint
{
    public static bool TryNormalize(string? value, out Uri endpoint, out string error)
    {
        endpoint = null!;
        error = "Enter a valid HTTPS service URL.";
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var parsed)
            || string.IsNullOrWhiteSpace(parsed.Host)
            || !string.IsNullOrEmpty(parsed.UserInfo)) return false;
#if DEBUG
        var secure = parsed.Scheme == Uri.UriSchemeHttps || parsed.IsLoopback;
#else
        var secure = parsed.Scheme == Uri.UriSchemeHttps;
#endif
        if (!secure) { error = "HTTPS is required. Local HTTP is accepted only in debug builds."; return false; }
        if (!string.IsNullOrEmpty(parsed.Query) || !string.IsNullOrEmpty(parsed.Fragment)) { error = "Remove query parameters and fragments from the service URL."; return false; }
        var builder = new UriBuilder(parsed) { Path = parsed.AbsolutePath.TrimEnd('/') + "/", Query = "", Fragment = "" };
        endpoint = builder.Uri;
        return true;
    }
}
