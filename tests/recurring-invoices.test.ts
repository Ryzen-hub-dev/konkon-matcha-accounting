import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceRecurringDate, assertRecurringInvoiceAction, assertRecurringInvoiceVersion,
  recurringDueDate, recurringInvoiceActionSchema, recurringInvoiceInputSchema,
  recurringOccurrenceRequestId, recurringScheduleObjectId,
} from "../lib/recurring-invoices";

const id = "1234567890abcdef12345678";
const requestId = "12345678-1234-4234-8234-123456789abc";
const version = "2026-09-22T10:15:30.123Z";
const fields = {
  name: "Monthly wholesale tea",
  memberId: id,
  billingAddress: "1 Matcha Lane",
  customerReference: "PO-42",
  notes: "Review before sending",
  templateId: "",
  dimensionSelection: { mode: "CUSTOMER_DEFAULT" as const, costCentreId: "", projectId: "" },
  items: [{ description: "Ceremonial matcha", quantity: 4, unitPrice: 38 }],
  frequency: "MONTHLY" as const,
  startDate: "2026-01-31",
  endDate: "2026-12-31",
  dueDays: 14,
  clientRequestId: requestId,
};

test("recurring invoice input requires an active-looking customer reference and sound dates", () => {
  const parsed = recurringInvoiceInputSchema.parse(fields);
  assert.equal(parsed.memberId, id);
  assert.equal(parsed.startDate, "2026-01-31");
  assert.equal(recurringInvoiceInputSchema.safeParse({ ...fields, endDate: "2026-01-30" }).success, false);
  assert.equal(recurringInvoiceInputSchema.safeParse({ ...fields, startDate: "2026-02-30" }).success, false);
  assert.equal(recurringInvoiceInputSchema.safeParse({ ...fields, memberId: "bad" }).success, false);
  assert.equal(recurringInvoiceInputSchema.safeParse({ ...fields, dueDays: 366 }).success, false);
});

test("calendar recurrence keeps its original month-end anchor", () => {
  assert.equal(advanceRecurringDate("2026-01-31", "MONTHLY", 31), "2026-02-28");
  assert.equal(advanceRecurringDate("2026-02-28", "MONTHLY", 31), "2026-03-31");
  assert.equal(advanceRecurringDate("2024-01-31", "MONTHLY", 31), "2024-02-29");
  assert.equal(advanceRecurringDate("2026-01-31", "QUARTERLY", 31), "2026-04-30");
  assert.equal(advanceRecurringDate("2024-02-29", "YEARLY", 29), "2025-02-28");
  assert.equal(advanceRecurringDate("2026-09-22", "WEEKLY", 22), "2026-09-29");
  assert.equal(recurringDueDate("2026-12-25", 14), "2027-01-08");
});

test("occurrence and schedule keys are deterministic and distinct", () => {
  const occurrence = recurringOccurrenceRequestId(id, "2026-09-22");
  assert.match(occurrence, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(occurrence, recurringOccurrenceRequestId(id, "2026-09-22"));
  assert.notEqual(occurrence, recurringOccurrenceRequestId(id, "2026-10-22"));
  assert.match(recurringScheduleObjectId(requestId), /^[0-9a-f]{24}$/);
  assert.equal(recurringScheduleObjectId(requestId), recurringScheduleObjectId(requestId));
});

test("schedule controls are versioned and forward-only", () => {
  assert.equal(recurringInvoiceActionSchema.safeParse({ action: "RUN_DUE" }).success, true);
  assert.equal(recurringInvoiceActionSchema.safeParse({ action: "PAUSE", id, expectedUpdatedAt: version }).success, true);
  assert.equal(recurringInvoiceActionSchema.safeParse({ action: "PAUSE", id }).success, false);
  assert.doesNotThrow(() => assertRecurringInvoiceVersion(new Date(version), version));
  assert.throws(() => assertRecurringInvoiceVersion(new Date(version), "2026-09-22T10:15:30.122Z"), /another session/i);
  assert.doesNotThrow(() => assertRecurringInvoiceAction("ACTIVE", "PAUSE"));
  assert.doesNotThrow(() => assertRecurringInvoiceAction("PAUSED", "RESUME"));
  assert.throws(() => assertRecurringInvoiceAction("ACTIVE", "RESUME"), /paused/i);
  assert.throws(() => assertRecurringInvoiceAction("COMPLETED", "END"), /already ended/i);
});
