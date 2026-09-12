import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import {
  hashOwnerRecoveryToken, isPendingOwnerRecovery, OWNER_RECOVERY_ID,
  OWNER_RECOVERY_MAX_BODY_BYTES, OwnerRecoveryError, ownerRecoveryRequestSchema,
  readOwnerRecoveryJson, type OwnerRecoveryGrant,
} from "../lib/owner-recovery";

const token = "abcdef12".repeat(8);
const now = new Date("2026-09-12T12:00:00.000Z");
const grant: OwnerRecoveryGrant = {
  _id: OWNER_RECOVERY_ID, tokenHash: hashOwnerRecoveryToken(token), status: "PENDING",
  expiresAt: new Date(now.getTime() + 60_000), previousOwnerId: new ObjectId(), createdAt: now,
};
const claim = { action: "CLAIM", token, fullName: "New Owner", username: "newowner", email: "owner@example.test", password: "StrongNewPass123" };

test("recovery accepts only strict inspect or claim requests and canonical hex tokens", () => {
  assert.equal(ownerRecoveryRequestSchema.safeParse({ action: "INSPECT", token }).success, true);
  assert.equal(ownerRecoveryRequestSchema.safeParse(claim).success, true);
  assert.equal(ownerRecoveryRequestSchema.parse({ action: "INSPECT", token: token.toUpperCase() }).token, token);
  for (const value of [{ action: "CREATE", token }, { action: "INSPECT", token, role: "OWNER" }, { ...claim, role: "OWNER" }, { ...claim, token: "not a token" }, { ...claim, token: "a".repeat(63) }, { ...claim, token: "z".repeat(64) }]) {
    assert.equal(ownerRecoveryRequestSchema.safeParse(value).success, false);
  }
});

test("recovery passwords require length, uppercase, lowercase and numbers without bcrypt truncation", () => {
  for (const password of ["admin123", "lowercase12345", "UPPERCASE12345", "NoNumbersHere", "aA1" + "x".repeat(70), "aA1" + "茶".repeat(24)]) {
    assert.equal(ownerRecoveryRequestSchema.safeParse({ ...claim, password }).success, false, password);
  }
  assert.equal(ownerRecoveryRequestSchema.safeParse({ ...claim, password: "aA1" + "x".repeat(69) }).success, true);
});

test("recovery capabilities are hashed, canonical and never accepted after expiry or consumption", () => {
  assert.equal(hashOwnerRecoveryToken(token).length, 64);
  assert.notEqual(hashOwnerRecoveryToken(token), token);
  assert.equal(hashOwnerRecoveryToken(token.toUpperCase()), hashOwnerRecoveryToken(token));
  assert.equal(isPendingOwnerRecovery(grant, token, now), true);
  assert.equal(isPendingOwnerRecovery(grant, "1".repeat(64), now), false);
  assert.equal(isPendingOwnerRecovery(grant, "invalid", now), false);
  assert.equal(isPendingOwnerRecovery(null, token, now), false);
  assert.equal(isPendingOwnerRecovery({ ...grant, expiresAt: now }, token, now), false);
  assert.equal(isPendingOwnerRecovery({ ...grant, expiresAt: new Date("invalid") }, token, now), false);
  assert.equal(isPendingOwnerRecovery({ ...grant, status: "CONSUMED" }, token, now), false);
  assert.equal(isPendingOwnerRecovery({ ...grant, status: "CANCELLED" }, token, now), false);
  assert.equal(isPendingOwnerRecovery({ ...grant, _id: "different-grant" }, token, now), false);
});

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/owner-recovery", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

test("recovery body parsing rejects malformed and oversized bodies including missing or false length", async () => {
  assert.deepEqual(await readOwnerRecoveryJson(jsonRequest(JSON.stringify({ action: "INSPECT", token }))), { action: "INSPECT", token });
  const status = (expected: number) => (error: unknown) => error instanceof OwnerRecoveryError && error.status === expected;
  await assert.rejects(readOwnerRecoveryJson(jsonRequest("{")), status(400));
  await assert.rejects(readOwnerRecoveryJson(jsonRequest("{}", { "Content-Type": "text/plain" })), status(415));
  await assert.rejects(readOwnerRecoveryJson(jsonRequest("{}", { "Content-Length": String(OWNER_RECOVERY_MAX_BODY_BYTES + 1) })), status(413));
  await assert.rejects(readOwnerRecoveryJson(jsonRequest(" ".repeat(OWNER_RECOVERY_MAX_BODY_BYTES + 1))), status(413));
  await assert.rejects(readOwnerRecoveryJson(jsonRequest(" ".repeat(OWNER_RECOVERY_MAX_BODY_BYTES + 1), { "Content-Length": "2" })), status(413));
});
