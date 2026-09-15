using KonkonMatcha.Client;

static void Expect(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

Expect(ServiceEndpoint.TryNormalize("https://example.com/accounting", out var valid, out _), "HTTPS endpoint should be accepted.");
Expect(valid.AbsoluteUri == "https://example.com/accounting/", "Endpoint should have one trailing slash.");
Expect(!ServiceEndpoint.TryNormalize("http://example.com", out _, out _), "Public HTTP endpoint must be rejected.");
Expect(!ServiceEndpoint.TryNormalize("https://user:pass@example.com", out _, out _), "Embedded credentials must be rejected.");
Expect(!ServiceEndpoint.TryNormalize("https://example.com?token=secret", out _, out _), "Endpoint query secrets must be rejected.");
Expect(!ServiceEndpoint.TryNormalize("javascript:alert(1)", out _, out _), "Non-web schemes must be rejected.");

Console.WriteLine("Endpoint security checks passed.");
