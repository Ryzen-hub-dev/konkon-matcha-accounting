import assert from "node:assert/strict";
import test from "node:test";
import { allocateLandedCost, landedCostInputSchema } from "../lib/landed-costs";

test("landed cost allocation preserves every minor unit and separates consumed stock", () => {
  const lines = allocateLandedCost({
    amount: 10.01,
    currency: "SGD",
    basis: "QUANTITY",
    lines: [
      { productId: "a", quantity: 3, returnedQuantity: 1, baseInventoryValue: 30, currentStock: 2 },
      { productId: "b", quantity: 1, baseInventoryValue: 20, currentStock: 0 },
    ],
  });
  assert.deepEqual(lines.map(line => line.allocatedAmount), [7.51, 2.5]);
  assert.equal(lines.reduce((sum, line) => sum + line.inventoryAmount + line.expenseAmount, 0), 10.01);
  assert.deepEqual(lines.map(line => line.inventoryAmount), [5, 0]);
  assert.deepEqual(lines.map(line => line.expenseAmount), [2.51, 2.5]);
  assert.equal(lines[0].unitCostIncrease * lines[0].currentStock, lines[0].inventoryAmount);
});

test("landed cost inputs require invoice evidence and valid tax", () => {
  const base = {
    receiptId: "507f1f77bcf86cd799439011",
    clientRequestId: "d8a3ca40-0ff0-4e75-bdb3-57cd4ffcbb6d",
    supplierId: "507f1f77bcf86cd799439012",
    supplierInvoiceNo: "FRT-100",
    invoiceDate: "2026-09-20",
    postedAt: "2026-09-22",
    total: 100,
    tax: 8,
    category: "FREIGHT" as const,
    allocationBasis: "VALUE" as const,
    description: "Inbound sea freight",
  };
  assert.equal(landedCostInputSchema.safeParse(base).success, true);
  assert.equal(landedCostInputSchema.safeParse({ ...base, tax: 101 }).success, false);
  assert.equal(landedCostInputSchema.safeParse({ ...base, description: "x" }).success, false);
});
