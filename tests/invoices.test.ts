import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInvoiceDraftEditable, assertInvoiceStatusTransition, assertInvoiceVersion,
  calculateInvoiceAmounts, invoiceDueDateSchema, invoiceEditSchema, invoiceInputSchema,
  invoiceStatusSchema, nextInvoiceUpdatedAt,
} from "../lib/invoices";

const id = "1234567890abcdef12345678";
const version = "2026-09-12T10:15:30.123Z";
const fields = {
  customerName: "Local shop", customerEmail: "", customerPhone: "", customerAddress: "",
  customerReference: "", dueDate: "2026-10-01", notes: "", templateId: "",
  items: [{ description: "Matcha catering", quantity: 3, unitPrice: 1.234 }],
};

test("invoice due dates reject impossible calendars instead of silently moving them", () => {
  for (const value of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-12", "2026-02-30T00:00:00.000Z", "not a date", ""]) {
    assert.equal(invoiceDueDateSchema.safeParse(value).success, false, value);
  }
  assert.equal(invoiceDueDateSchema.parse("2028-02-29").toISOString(), "2028-02-29T00:00:00.000Z");
  assert.equal(invoiceDueDateSchema.parse("2026-10-01T00:00:00.000Z").toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(invoiceDueDateSchema.parse("2026-10-01T00:00:00Z").toISOString(), "2026-10-01T00:00:00.000Z");
});

test("invoice calendar dates reject timezone-shifting instants and non-string coercions", () => {
  for (const value of ["2026-10-01T12:00:00Z", "2026-10-01T00:00:00+08:00", "2026-10-01T00:00:00.001Z", 0, null, new Date()]) {
    assert.equal(invoiceDueDateSchema.safeParse(value).success, false);
  }
});

test("invoice creation remains compatible without request keys and validates UUID keys", () => {
  const minimal = { customerName: "New customer", dueDate: "2026-10-01", items: fields.items };
  const legacy = invoiceInputSchema.parse(minimal);
  assert.equal(legacy.clientRequestId, undefined);
  assert.equal(legacy.customerEmail, "");
  assert.equal(legacy.templateId, "");
  assert.equal(invoiceInputSchema.parse({ ...minimal, clientRequestId: "12345678-1234-4234-8234-123456789abc" }).clientRequestId, "12345678-1234-4234-8234-123456789abc");
  assert.equal(invoiceInputSchema.safeParse({ ...minimal, clientRequestId: "repeat-me" }).success, false);
});

test("draft editing requires a complete form and an expected version", () => {
  const edit = { ...fields, action: "EDIT_DRAFT", id, expectedUpdatedAt: version };
  assert.equal(invoiceEditSchema.safeParse(edit).success, true);
  for (const field of ["expectedUpdatedAt", "customerEmail", "customerPhone", "customerAddress", "customerReference", "notes", "templateId", "items"]) {
    const missing: Record<string, unknown> = { ...edit };
    delete missing[field];
    assert.equal(invoiceEditSchema.safeParse(missing).success, false, field);
  }
  assert.equal(invoiceEditSchema.safeParse({ ...edit, expectedUpdatedAt: "2026-02-30T00:00:00Z" }).success, false);
  assert.equal(invoiceEditSchema.safeParse({ ...edit, expectedUpdatedAt: "2026-09-12" }).success, false);
});

test("invoice object references are validated and canonicalized", () => {
  assert.equal(invoiceInputSchema.parse({ ...fields, templateId: id.toUpperCase() }).templateId, id);
  assert.equal(invoiceInputSchema.parse({ ...fields, memberId: id.toUpperCase() }).memberId, id);
  assert.equal(invoiceInputSchema.parse(fields).memberId, "");
  assert.equal(invoiceInputSchema.safeParse({ ...fields, templateId: "z".repeat(24) }).success, false);
  assert.equal(invoiceInputSchema.safeParse({ ...fields, memberId: "z".repeat(24) }).success, false);
  assert.equal(invoiceEditSchema.safeParse({ ...fields, action: "EDIT_DRAFT", id: "z".repeat(24), expectedUpdatedAt: version }).success, false);
});

test("invoice input bounds reject empty lines and non-finite amounts", () => {
  for (const items of [[], [{ description: "Matcha", quantity: 0, unitPrice: 1 }], [{ description: "Matcha", quantity: 1, unitPrice: Infinity }], [{ description: "Matcha", quantity: -1, unitPrice: 1 }]]) {
    assert.equal(invoiceInputSchema.safeParse({ ...fields, items }).success, false);
  }
});

test("invoice calculations round unit price before line totals with zero, two and three decimals", () => {
  const line = [{ description: "Local service", quantity: 3, unitPrice: 1.2345 }];
  const jpy = calculateInvoiceAmounts(line, "JPY", 0, "EXCLUSIVE");
  assert.equal(jpy.items[0].unitPrice, 1);
  assert.equal(jpy.items[0].lineTotal, 3);
  assert.equal(jpy.total, 3);
  const eur = calculateInvoiceAmounts(line, "EUR", 0, "EXCLUSIVE");
  assert.equal(eur.items[0].unitPrice, 1.23);
  assert.equal(eur.total, 3.69);
  const kwd = calculateInvoiceAmounts(line, "KWD", 0, "EXCLUSIVE");
  assert.equal(kwd.items[0].unitPrice, 1.235);
  assert.equal(kwd.total, 3.705);
});

test("invoice totals preserve the supplied original tax context", () => {
  const line = [{ description: "Matcha", quantity: 2, unitPrice: 10 }];
  const exclusive = calculateInvoiceAmounts(line, "MYR", 8, "EXCLUSIVE");
  assert.equal(exclusive.taxRate, 8);
  assert.equal(exclusive.taxMode, "EXCLUSIVE");
  assert.equal(exclusive.total, 21.6);
  assert.equal(exclusive.netSales, 20);
  const inclusive = calculateInvoiceAmounts(line, "KWD", 7, "INCLUSIVE");
  assert.equal(inclusive.total, 20);
  assert.equal(inclusive.tax, 1.308);
  assert.equal(inclusive.netSales, 18.692);
});

test("invoice amounts reject unsafe integer precision for very large documents", () => {
  const lines = Array.from({ length: 50 }, () => ({ description: "Large line", quantity: 100_000, unitPrice: 100_000_000 }));
  assert.throws(() => calculateInvoiceAmounts(lines, "KWD", 0, "EXCLUSIVE"), /too large/);
});

test("only unpaid drafts can be edited", () => {
  assert.doesNotThrow(() => assertInvoiceDraftEditable({ status: "DRAFT", paidAmount: 0 }));
  assert.doesNotThrow(() => assertInvoiceDraftEditable({ status: "DRAFT" }));
  for (const status of ["SENT", "PAID", "VOID"]) assert.throws(() => assertInvoiceDraftEditable({ status, paidAmount: 0 }), /unpaid draft/);
  assert.throws(() => assertInvoiceDraftEditable({ status: "DRAFT", paidAmount: 0.001 }), /unpaid draft/);
});

test("sent invoices cannot reopen and paid or void invoices cannot be changed", () => {
  for (const target of ["SENT", "PAID", "VOID"]) assert.doesNotThrow(() => assertInvoiceStatusTransition({ status: "DRAFT", paidAmount: 0 }, target));
  assert.throws(() => assertInvoiceStatusTransition({ status: "SENT", paidAmount: 0 }, "DRAFT"), /sent invoice/);
  assert.doesNotThrow(() => assertInvoiceStatusTransition({ status: "SENT", paidAmount: 0 }, "PAID"));
  assert.doesNotThrow(() => assertInvoiceStatusTransition({ status: "PAID", paidAmount: 20 }, "PAID"));
  assert.throws(() => assertInvoiceStatusTransition({ status: "PAID", paidAmount: 20 }, "VOID"), /paid invoice/);
  assert.throws(() => assertInvoiceStatusTransition({ status: "VOID", paidAmount: 0 }, "DRAFT"), /already void/);
  assert.throws(() => assertInvoiceStatusTransition({ status: "DRAFT", paidAmount: 1 }, "PAID"), /draft workflow/);
});

test("invoice optimistic versions detect conflicts and advance even within a millisecond", () => {
  assert.doesNotThrow(() => assertInvoiceVersion(new Date(version), version));
  assert.doesNotThrow(() => assertInvoiceVersion(new Date(version), "2026-09-12T18:15:30.123+08:00"));
  assert.throws(() => assertInvoiceVersion(new Date(version), "2026-09-12T10:15:30.122Z"), /another session/);
  assert.throws(() => assertInvoiceVersion(undefined, version), /another session/);
  assert.equal(nextInvoiceUpdatedAt(new Date(version), new Date(version)).toISOString(), "2026-09-12T10:15:30.124Z");
  assert.equal(nextInvoiceUpdatedAt(new Date(version), new Date("2026-09-12T10:15:30.100Z")).toISOString(), "2026-09-12T10:15:30.124Z");
  assert.equal(invoiceStatusSchema.safeParse({ id, status: "SENT" }).success, true);
  assert.equal(invoiceStatusSchema.safeParse({ id, status: "SENT", expectedUpdatedAt: version }).success, true);
});
