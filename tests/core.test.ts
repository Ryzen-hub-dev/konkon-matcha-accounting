import assert from "node:assert/strict";
import test from "node:test";
import { asMoney, makeDocumentNo } from "../lib/format";
import { canManageRole, hasPermission } from "../lib/rbac";
import { POST as login } from "../app/api/auth/login/route";
import { POST as setup } from "../app/api/setup/route";

function sameOriginRequest(path: string, body: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost" },
    body,
  });
}

test("money values are rounded to accounting precision", () => {
  assert.equal(asMoney(10.005), 10.01);
  assert.equal(asMoney("46.90"), 46.9);
  assert.equal(asMoney("not-a-number"), 0);
});

test("document numbers are recognisable and collision resistant", () => {
  const first = makeDocumentNo("INV");
  const second = makeDocumentNo("INV");
  assert.match(first, /^INV-\d{8}-[A-F0-9]{6}$/);
  assert.notEqual(first, second);
});

test("cashier permissions stop at the counter", () => {
  assert.equal(hasPermission("CASHIER", "pos.sell"), true);
  assert.equal(hasPermission("CASHIER", "accounting.write"), false);
  assert.equal(hasPermission("CASHIER", "team.write"), false);
});

test("owner remains the only role that can manage administrators", () => {
  assert.equal(canManageRole("OWNER", "ADMIN"), true);
  assert.equal(canManageRole("ADMIN", "ADMIN"), false);
  assert.equal(canManageRole("ADMIN", "MANAGER"), true);
  assert.equal(canManageRole("OWNER", "OWNER"), false);
});

test("setup and login return JSON errors for malformed request bodies", async () => {
  const previousSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-only-auth-secret-with-at-least-32-characters";
  try {
    for (const [path, handler] of [["/api/setup", setup], ["/api/auth/login", login]] as const) {
      const response = await handler(sameOriginRequest(path, "{"));
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
      assert.equal(body.ok, false);
      assert.match(body.error, /valid JSON/i);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
  }
});

test("setup rejects invalid fields before touching the database", async () => {
  const previousSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-only-auth-secret-with-at-least-32-characters";
  try {
    const response = await setup(sameOriginRequest("/api/setup", JSON.stringify({ businessName: "x" })));
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.ok(body.issues.businessName);
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
  }
});

test("authentication endpoints reject cross-origin requests", async () => {
  const response = await login(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "https://attacker.example" },
    body: JSON.stringify({ identity: "owner", password: "password" }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "This request was blocked." });
});
