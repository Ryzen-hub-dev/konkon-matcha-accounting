import assert from "node:assert/strict";
import test from "node:test";
import { allocationTotal, stockTransferActionSchema, stockTransferPostSchema, transferUnitTotal } from "../lib/inventory-locations";

const firstId = "a".repeat(24);
const secondId = "b".repeat(24);
const productId = "c".repeat(24);

test("location allocation totals whole non-negative units", () => {
  assert.equal(allocationTotal([{ quantity: 3 }, { quantity: 7 }]), 10);
  assert.equal(allocationTotal([{ quantity: -2 }, { quantity: 2.9 }]), 2);
});

test("location activation requires a stable request and unique locations", () => {
  const request = { action: "ALLOCATE", clientRequestId: crypto.randomUUID(), productId, allocations: [{ locationId: firstId, quantity: 4 }, { locationId: secondId, quantity: 6 }] };
  assert.equal(stockTransferPostSchema.safeParse(request).success, true);
  assert.equal(stockTransferPostSchema.safeParse({ ...request, clientRequestId: "retry", allocations: [request.allocations[0], request.allocations[0]] }).success, false);
});

test("a stock transfer rejects identical locations and duplicate products", () => {
  const base = { action: "DISPATCH", clientRequestId: crypto.randomUUID(), sourceLocationId: firstId, destinationLocationId: secondId, note: "", items: [{ productId, quantity: 2 }] };
  assert.equal(stockTransferPostSchema.safeParse(base).success, true);
  assert.equal(stockTransferPostSchema.safeParse({ ...base, destinationLocationId: firstId }).success, false);
  assert.equal(stockTransferPostSchema.safeParse({ ...base, items: [base.items[0], base.items[0]] }).success, false);
});

test("transfer completion uses optimistic versions and cancellation evidence", () => {
  assert.equal(stockTransferActionSchema.safeParse({ id: firstId, version: 0, action: "RECEIVE", note: "" }).success, true);
  assert.equal(stockTransferActionSchema.safeParse({ id: firstId, version: 0, action: "CANCEL", note: "" }).success, false);
  assert.equal(stockTransferActionSchema.safeParse({ id: firstId, version: 2, action: "CANCEL", note: "Vehicle returned" }).success, true);
  assert.equal(stockTransferActionSchema.safeParse({ id: firstId, action: "RECEIVE", note: "" }).success, false);
});

test("in-transit totals count every transfer line", () => {
  assert.equal(transferUnitTotal([{ quantity: 3 }, { quantity: 7 }]), 10);
});
