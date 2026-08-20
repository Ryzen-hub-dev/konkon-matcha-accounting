using System;
using System.Collections.Generic;

namespace MatchaAccounting
{
    public sealed class ApiResponse<T>
    {
        public bool Success { get; set; }
        public string Message { get; set; }
        public T Data { get; set; }
    }

    public sealed class AuthResult
    {
        public string AccessToken { get; set; }
        public string RefreshToken { get; set; }
        public UserProfile User { get; set; }
        public IList<string> Permissions { get; set; } = Array.Empty<string>();
        public int ExpiresInSeconds { get; set; }
    }

    public sealed class UserProfile
    {
        public string UserId { get; set; }
        public string Username { get; set; }
        public string FullName { get; set; }
        public string Email { get; set; }
        public string Role { get; set; }
    }

    public sealed class LoginRequest
    {
        public string Username { get; set; }
        public string Password { get; set; }
    }

    public sealed class LoginError
    {
        public string Code { get; set; }
        public string Message { get; set; }
    }

    public sealed class AuthSession
    {
        public string AccessToken { get; set; }
        public string RefreshToken { get; set; }
        public UserProfile User { get; set; }
        public DateTimeOffset ExpiresAtUtc { get; set; }
        public IList<string> Permissions { get; set; } = Array.Empty<string>();
    }
}
