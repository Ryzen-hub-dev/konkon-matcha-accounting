import assert from "node:assert/strict";
import test from "node:test";
import {
  bankFeedPayloadSchema,
  normaliseBankFeedEvent,
  signBankFeed,
  verifyBankFeedSignature,
} from "../lib/bank-connections";

test("bank feed signatures bind timestamp and exact request bytes", () => {
  const secret = "test-secret-with-enough-entropy";
  const timestamp = "1789956000";
  const body = JSON.stringify({ events: [{ eventId: "evt-1001" }] });
  const signature = signBankFeed(secret, timestamp, body);
  assert.equal(
    verifyBankFeedSignature(
      secret,
      timestamp,
      body,
      signature,
      Number(timestamp) * 1_000,
    ),
    true,
  );
  assert.equal(
    verifyBankFeedSignature(
      secret,
      timestamp,
      `${body} `,
      signature,
      Number(timestamp) * 1_000,
    ),
    false,
  );
  assert.equal(
    verifyBankFeedSignature(
      secret,
      timestamp,
      body,
      signature,
      Number(timestamp) * 1_000 + 300_001,
    ),
    false,
  );
});

test("bank feed events enforce limits, currency and accounting precision", () => {
  const parsed = bankFeedPayloadSchema.parse({
    events: [
      {
        eventId: "evt-1001",
        postedAt: "2026-09-24T08:00:00+08:00",
        amount: -18.5,
        currency: "MYR",
        description: "Supplier transfer",
        reference: "BANK-1",
        runningBalance: 1000.5,
      },
    ],
  });
  const event = normaliseBankFeedEvent(parsed.events[0], "MYR");
  assert.equal(event.amount, -18.5);
  assert.equal(event.postedAt.toISOString(), "2026-09-24T00:00:00.000Z");
  assert.throws(
    () => normaliseBankFeedEvent(parsed.events[0], "SGD"),
    /currency/,
  );
  assert.throws(
    () => normaliseBankFeedEvent({ ...parsed.events[0], amount: 1.001 }, "MYR"),
    /precision/,
  );
  assert.equal(
    bankFeedPayloadSchema.safeParse({
      events: [parsed.events[0], parsed.events[0]],
    }).success,
    false,
  );
});
