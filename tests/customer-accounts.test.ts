import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomerStatement, customerAccountUpdateSchema, evaluateCustomerCredit } from "../lib/customer-accounts";

test("customer credit controls distinguish holds, configured limits and unlimited accounts", () => {
  assert.deepEqual(evaluateCustomerCredit({ creditLimit: null, outstanding: 90, newCharge: 20, currency: "MYR" }), {
    allowed: true,
    projectedOutstanding: 110,
  });
  assert.equal(evaluateCustomerCredit({ creditLimit: 100, outstanding: 90, newCharge: 10, currency: "MYR" }).allowed, true);
  const over = evaluateCustomerCredit({ creditLimit: 100, outstanding: 90, newCharge: 10.01, currency: "MYR" });
  assert.equal(over.allowed, false);
  assert.equal(over.projectedOutstanding, 100.01);
  assert.match(over.reason || "", /credit limit/i);
  const held = evaluateCustomerCredit({ creditHold: true, creditLimit: null, outstanding: 0, newCharge: 1, currency: "MYR" });
  assert.equal(held.allowed, false);
  assert.match(held.reason || "", /credit hold/i);
});

test("credit-control updates require an optimistic version and a reason", () => {
  const valid = {
    id: "1234567890abcdef12345678",
    expectedUpdatedAt: "2026-09-18T01:02:03.000Z",
    creditLimit: 500,
    creditTermsDays: 30,
    creditHold: false,
    reason: "Owner approved monthly trade terms",
  };
  assert.equal(customerAccountUpdateSchema.safeParse(valid).success, true);
  assert.equal(customerAccountUpdateSchema.safeParse({ ...valid, creditLimit: null }).success, true);
  assert.equal(customerAccountUpdateSchema.parse(valid).dimensionDefaults, undefined);
  assert.equal(customerAccountUpdateSchema.safeParse({ ...valid, dimensionDefaults: { costCentreId: "invalid", projectId: "" } }).success, false);
  assert.equal(customerAccountUpdateSchema.safeParse({ ...valid, reason: "" }).success, false);
  assert.equal(customerAccountUpdateSchema.safeParse({ ...valid, creditTermsDays: 366 }).success, false);
  assert.equal(customerAccountUpdateSchema.safeParse({ ...valid, expectedUpdatedAt: "2026-09-18" }).success, false);
});

test("customer statements exclude drafts and voids and keep a chronological running balance", () => {
  const statement = buildCustomerStatement([
    { _id: "paid", invoiceNo: "INV-2", status: "PAID", total: 40, paidAmount: 40, createdAt: "2026-09-02T00:00:00Z", sentAt: "2026-09-02T00:00:00Z", paidAt: "2026-09-05T00:00:00Z", dueDate: "2026-09-20T00:00:00Z" },
    { _id: "open", invoiceNo: "INV-1", status: "SENT", total: 60, paidAmount: 0, createdAt: "2026-09-01T00:00:00Z", sentAt: "2026-09-01T00:00:00Z", dueDate: "2026-09-10T00:00:00Z" },
    { _id: "draft", invoiceNo: "INV-D", status: "DRAFT", total: 999, createdAt: "2026-09-01T00:00:00Z", dueDate: "2026-09-01T00:00:00Z" },
    { _id: "void", invoiceNo: "INV-V", status: "VOID", total: 999, createdAt: "2026-09-01T00:00:00Z", dueDate: "2026-09-01T00:00:00Z" },
  ], "MYR", "2026-09-18");
  assert.deepEqual(statement.summary, { invoiced: 100, paid: 40, outstanding: 60, overdue: 60 });
  assert.deepEqual(statement.entries.map(entry => [entry.type, entry.invoiceNo, entry.balance]), [
    ["INVOICE", "INV-1", 60],
    ["INVOICE", "INV-2", 100],
    ["PAYMENT", "INV-2", 60],
  ]);
});
