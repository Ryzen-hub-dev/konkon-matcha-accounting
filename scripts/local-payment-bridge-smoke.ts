import assert from "node:assert/strict";

const baseUrl = process.env.LOCAL_PAYMENT_SMOKE_URL || "http://127.0.0.1:17329";
const origin = process.env.LOCAL_PAYMENT_SMOKE_ORIGIN || "http://localhost:3000";
const pairCode = process.env.LOCAL_PAYMENT_SMOKE_PAIR_CODE || "654321";
const notifyToken = process.env.LOCAL_PAYMENT_SMOKE_NOTIFY_TOKEN || "notify-integration-test-token-123456789";

async function responseJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { response, body };
}

async function main() {
const deniedPair = await responseJson("/pair", {
  method: "POST",
  headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
  body: JSON.stringify({ code: pairCode }),
});
assert.equal(deniedPair.response.status, 403);

const paired = await responseJson("/pair", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ code: pairCode }),
});
assert.equal(paired.response.status, 200, paired.body.error);
const token = String(paired.body.data?.token || "");
const cursor = Number(paired.body.data?.cursor || 0);
assert.match(token, /^[A-Za-z0-9_-]{32,128}$/);

const timestamp = new Date().toISOString();
const paymentBody = {
  type: "SMS",
  sender: "TNG",
  message: "Touch n Go payment received RM 18.80 ref TNG-778899",
  timestamp,
};
const notifyHeaders = {
  Authorization: `Bearer ${notifyToken}`,
  "Content-Type": "application/json",
};
const unauthorized = await responseJson("/notify-me/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(paymentBody),
});
assert.equal(unauthorized.response.status, 401);

const payment = await responseJson("/notify-me/", { method: "POST", headers: notifyHeaders, body: JSON.stringify(paymentBody) });
assert.equal(payment.response.status, 200, payment.body.error);
assert.equal(payment.body.data?.accepted, true);

const duplicate = await responseJson("/notify-me", { method: "POST", headers: notifyHeaders, body: JSON.stringify(paymentBody) });
assert.equal(duplicate.response.status, 200, duplicate.body.error);
assert.equal(duplicate.body.data?.accepted, true);

const otp = await responseJson("/notify-me", {
  method: "POST",
  headers: notifyHeaders,
  body: JSON.stringify({ type: "SMS", sender: "TNG", message: "Your OTP is 882211 for login", timestamp: new Date().toISOString() }),
});
assert.equal(otp.response.status, 200, otp.body.error);
assert.equal(otp.body.data?.accepted, false);
assert.equal(otp.body.data?.reason, "PRIVACY_BLOCKED");

const queued = await responseJson(`/events?after=${cursor}`, {
  headers: { Origin: origin, Authorization: `Bearer ${token}` },
});
assert.equal(queued.response.status, 200, queued.body.error);
const events = queued.body.data?.events as Array<Record<string, unknown>>;
assert.equal(events.length, 1, "Dual delivery should produce one queued event.");
assert.equal(events[0]?.provider, "TNG");
assert.equal(events[0]?.currency, "MYR");
assert.equal(events[0]?.amount, 18.8);
assert.equal("message" in events[0], false);
assert.equal("content" in events[0], false);
assert.equal("sender" in events[0], false);

process.stdout.write("Local payment bridge smoke test passed: origin guard, pairing, payment parsing, deduplication, OTP blocking and privacy projection.\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
