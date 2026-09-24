import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Db } from "mongodb";
import {
  getMyInvoisSubmission,
  MyInvoisError,
  myInvoisBaseUrl,
  myInvoisConnectionInputSchema,
  myInvoisSubmissionEnvelope,
  myInvoisSubmissionFailureState,
} from "../lib/myinvois-connection";

test("MyInvois environments use only the official fixed identity and API hosts", () => {
  assert.equal(
    myInvoisBaseUrl("SANDBOX"),
    "https://preprod-api.myinvois.hasil.gov.my",
  );
  assert.equal(
    myInvoisBaseUrl("PRODUCTION"),
    "https://api.myinvois.hasil.gov.my",
  );
  assert.equal(
    myInvoisConnectionInputSchema.safeParse({
      environment: "LOCAL",
      clientId: "x",
      clientSecret: "y",
    }).success,
    false,
  );
});

test("MyInvois submission minifies, hashes and base64-encodes the exact JSON bytes", () => {
  const content = '{\n  "Invoice": [{ "ID": [{ "_": "INV-1" }] }]\n}';
  const envelope = myInvoisSubmissionEnvelope(content, "INV-1");
  const minified = '{"Invoice":[{"ID":[{"_":"INV-1"}]}]}';
  assert.equal(
    Buffer.from(envelope.documents[0].document, "base64").toString("utf8"),
    minified,
  );
  assert.equal(
    envelope.documents[0].documentHash,
    createHash("sha256").update(minified).digest("hex"),
  );
  assert.equal(envelope.documents[0].format, "JSON");
  assert.equal(envelope.documents[0].codeNumber, "INV-1");
});

test("MyInvois submission rejects invalid JSON and the official 300 KB document limit", () => {
  assert.throws(
    () => myInvoisSubmissionEnvelope("not json", "INV-1"),
    /invalid/,
  );
  assert.throws(
    () =>
      myInvoisSubmissionEnvelope(
        JSON.stringify({ value: "x".repeat(300_001) }),
        "INV-2",
      ),
    /300 KB/,
  );
});

test("uncertain MyInvois outcomes block blind resubmission", () => {
  assert.equal(
    myInvoisSubmissionFailureState(
      new MyInvoisError("network result unknown", 503, true),
    ),
    "REVIEW_REQUIRED",
  );
  assert.equal(
    myInvoisSubmissionFailureState(new MyInvoisError("rate limited", 429)),
    "RETRY_ALLOWED",
  );
});

test("status refresh cannot cross MyInvois environments", async () => {
  const db = {
    collection: () => ({ findOne: async () => ({ environment: "SANDBOX" }) }),
  } as unknown as Db;
  await assert.rejects(
    () => getMyInvoisSubmission(db, "SUBMISSION_1", fetch, "PRODUCTION"),
    /Reconnect the production MyInvois environment/,
  );
});
