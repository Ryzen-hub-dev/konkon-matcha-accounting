import assert from "node:assert/strict";
import test from "node:test";
import {
  assertQuotationAction, assertQuotationVersion, nextQuotationUpdatedAt,
  quotationActionSchema, quotationEditSchema, quotationEffectiveStatus, quotationInputSchema,
} from "../lib/quotations";

const id = "1234567890abcdef12345678";
const version = "2026-09-18T10:15:30.123Z";
const fields = {
  customerName: "Wholesale partner", customerEmail: "", customerPhone: "", customerAddress: "",
  customerReference: "EVENT-42", validUntil: "2026-10-01", notes: "Subject to availability",
  items: [{ description: "Matcha catering", quantity: 2, unitPrice: 50 }],
};

test("quotation drafts validate calendar dates, customer links and retry keys", () => {
  const parsed = quotationInputSchema.parse({ ...fields, memberId: id.toUpperCase(), clientRequestId: "12345678-1234-4234-8234-123456789abc" });
  assert.equal(parsed.memberId, id);
  assert.equal(parsed.validUntil.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(quotationInputSchema.parse(fields).memberId, "");
  for (const validUntil of ["2026-02-30", "2026-10-01T12:00:00Z", "not-a-date"]) {
    assert.equal(quotationInputSchema.safeParse({ ...fields, validUntil }).success, false);
  }
  assert.equal(quotationInputSchema.safeParse({ ...fields, memberId: "bad" }).success, false);
});

test("quotation edits require a complete draft and optimistic version", () => {
  const edit = { ...fields, action: "EDIT_DRAFT", id, expectedUpdatedAt: version };
  assert.equal(quotationEditSchema.safeParse(edit).success, true);
  for (const field of ["customerName", "validUntil", "items", "expectedUpdatedAt"]) {
    const missing: Record<string, unknown> = { ...edit };
    delete missing[field];
    assert.equal(quotationEditSchema.safeParse(missing).success, false, field);
  }
  assert.doesNotThrow(() => assertQuotationVersion(new Date(version), version));
  assert.throws(() => assertQuotationVersion(new Date(version), "2026-09-18T10:15:30.122Z"), /another session/i);
  assert.equal(nextQuotationUpdatedAt(new Date(version), new Date(version)).toISOString(), "2026-09-18T10:15:30.124Z");
});

test("quotation actions require decision evidence and an invoice due date", () => {
  assert.equal(quotationActionSchema.safeParse({ action: "MARK_SENT", id, expectedUpdatedAt: version }).success, true);
  assert.equal(quotationActionSchema.safeParse({ action: "ACCEPT", id, expectedUpdatedAt: version, note: "Confirmed by customer on phone" }).success, true);
  assert.equal(quotationActionSchema.safeParse({ action: "ACCEPT", id, note: "" }).success, false);
  assert.equal(quotationActionSchema.safeParse({ action: "REJECT", id, note: "No" }).success, false);
  assert.equal(quotationActionSchema.safeParse({ action: "CONVERT", id, expectedUpdatedAt: version, dueDate: "2026-10-20" }).success, true);
  assert.equal(quotationActionSchema.safeParse({ action: "CONVERT", id, expectedUpdatedAt: version }).success, false);
  assert.equal(quotationActionSchema.safeParse({ action: "MARK_SENT", id }).success, false);
});

test("quotation workflow is forward-only and expired offers cannot be accepted", () => {
  assert.doesNotThrow(() => assertQuotationAction("DRAFT", "MARK_SENT", "2026-10-01", "2026-09-18"));
  assert.doesNotThrow(() => assertQuotationAction("SENT", "ACCEPT", "2026-10-01", "2026-09-18"));
  assert.doesNotThrow(() => assertQuotationAction("SENT", "REJECT", "2026-09-01", "2026-09-18"));
  assert.doesNotThrow(() => assertQuotationAction("ACCEPTED", "CONVERT", "2026-09-01", "2026-09-18"));
  assert.throws(() => assertQuotationAction("DRAFT", "MARK_SENT", "2026-09-01", "2026-09-18"), /expired/i);
  assert.throws(() => assertQuotationAction("SENT", "ACCEPT", "2026-09-01", "2026-09-18"), /expired/i);
  assert.throws(() => assertQuotationAction("CONVERTED", "CONVERT", "2026-10-01", "2026-09-18"), /cannot/i);
});

test("sent quotations expose an effective expired state without rewriting history", () => {
  assert.equal(quotationEffectiveStatus("SENT", "2026-09-17T00:00:00.000Z", "2026-09-18"), "EXPIRED");
  assert.equal(quotationEffectiveStatus("SENT", "2026-09-18T00:00:00.000Z", "2026-09-18"), "SENT");
  assert.equal(quotationEffectiveStatus("ACCEPTED", "2026-09-01T00:00:00.000Z", "2026-09-18"), "ACCEPTED");
});
