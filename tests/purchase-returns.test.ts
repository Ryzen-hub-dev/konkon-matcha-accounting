import assert from "node:assert/strict";
import test from "node:test";
import { allocatePurchaseReceiptLineFinancials, purchaseReturnObjectId, purchaseReturnSchema, slicePurchaseReturnLine } from "../lib/purchase-returns";
import { currencyMinorUnits } from "../lib/international";

const productA = "1234567890abcdef12345678";
const productB = "abcdef1234567890abcdef12";

test("purchase return input requires one unique positive line and supplier evidence", () => {
  const valid = { billId: productA, clientRequestId: crypto.randomUUID(), supplierCreditNo: "CN-104", expectedUpdatedAt: "2026-09-22T10:00:00.000Z", returnedAt: "2026-09-22", reason: "Damaged cartons", lines: [{ productId: productB, quantity: 2 }] };
  assert.equal(purchaseReturnSchema.safeParse(valid).success, true);
  assert.equal(purchaseReturnSchema.safeParse({ ...valid, reason: "x" }).success, false);
  assert.equal(purchaseReturnSchema.safeParse({ ...valid, lines: [...valid.lines, ...valid.lines] }).success, false);
  assert.equal(purchaseReturnSchema.safeParse({ ...valid, lines: [{ productId: productB, quantity: 0 }] }).success, false);
});

test("receipt line allocation and repeated return slices preserve every minor unit", () => {
  const lines = allocatePurchaseReceiptLineFinancials([
    { productId: productA, quantity: 3, lineTotal: 10, baseInventoryValue: 7.41 },
    { productId: productB, quantity: 2, lineTotal: 5, baseInventoryValue: 3.7 },
  ], { netSales: 15, tax: 1.05, total: 16.05, baseTax: 0.78 }, "USD", "SGD");
  assert.equal(currencyMinorUnits(lines.reduce((sum, line) => sum + line.lineGross, 0), "USD"), 1605);
  assert.equal(currencyMinorUnits(lines.reduce((sum, line) => sum + line.baseTotal, 0), "SGD"), 1189);
  const first = slicePurchaseReturnLine(lines[0], 0, 1, "USD", "SGD");
  const rest = slicePurchaseReturnLine(lines[0], 1, 2, "USD", "SGD");
  assert.equal(currencyMinorUnits(first.supplierNet + first.supplierTax, "USD"), currencyMinorUnits(first.supplierTotal, "USD"));
  assert.equal(currencyMinorUnits(rest.supplierNet + rest.supplierTax, "USD"), currencyMinorUnits(rest.supplierTotal, "USD"));
  assert.equal(currencyMinorUnits(first.originalBaseInventory + first.baseTax, "SGD"), currencyMinorUnits(first.baseTotal, "SGD"));
  assert.equal(currencyMinorUnits(rest.originalBaseInventory + rest.baseTax, "SGD"), currencyMinorUnits(rest.baseTotal, "SGD"));
  assert.equal(currencyMinorUnits(first.supplierTotal + rest.supplierTotal, "USD"), currencyMinorUnits(lines[0].lineGross, "USD"));
  assert.equal(currencyMinorUnits(first.baseTotal + rest.baseTotal, "SGD"), currencyMinorUnits(lines[0].baseTotal, "SGD"));
});

test("purchase return identifiers are deterministic ObjectIds", () => {
  const requestId = "12345678-1234-4234-8234-123456789abc";
  assert.match(purchaseReturnObjectId(requestId), /^[0-9a-f]{24}$/);
  assert.equal(purchaseReturnObjectId(requestId), purchaseReturnObjectId(requestId));
});
