import assert from "node:assert/strict";
import test from "node:test";
import { ninjaVanConnectionInputSchema, ninjaVanOAuthUrl, validateNinjaVanCredentials } from "../lib/shipping-connections";

test("Ninja Van OAuth URLs are fixed to documented hosts and sandbox always uses SG", () => {
  assert.equal(ninjaVanOAuthUrl("SANDBOX", "MY"), "https://api-sandbox.ninjavan.co/sg/2.0/oauth/access_token");
  assert.equal(ninjaVanOAuthUrl("PRODUCTION", "MY"), "https://api.ninjavan.co/my/2.0/oauth/access_token");
  assert.equal(ninjaVanConnectionInputSchema.safeParse({ environment: "CUSTOM", countryCode: "MY" }).success, false);
});

test("Ninja Van connection validation sends only the documented client-credentials request", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ access_token: "temporary-token", expires_in: 3600 }), { status: 200 });
  };
  const result = await validateNinjaVanCredentials({ environment: "SANDBOX", countryCode: "MY", clientId: "client-id", clientSecret: "client-key" }, request as typeof fetch);
  assert.equal(capturedUrl, "https://api-sandbox.ninjavan.co/sg/2.0/oauth/access_token");
  assert.deepEqual(JSON.parse(capturedBody), { client_id: "client-id", client_secret: "client-key", grant_type: "client_credentials" });
  assert.deepEqual(result, { expiresIn: 3600 });
});

test("Ninja Van credential failures are reduced to safe actionable errors", async () => {
  const denied = async () => new Response("sensitive upstream text", { status: 401 });
  await assert.rejects(
    validateNinjaVanCredentials({ environment: "PRODUCTION", countryCode: "SG", clientId: "bad", clientSecret: "bad" }, denied as typeof fetch),
    /rejected these credentials/,
  );
});
