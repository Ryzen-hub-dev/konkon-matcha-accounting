import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateFefo,
  batchExpiryStatus,
  batchIdentityKey,
  forecastBatchFreshness,
  inventoryBatchActionSchema,
  openingTotalsByLocation,
  sliceBatchAllocations,
} from "../lib/inventory-batches";

const productId = "a".repeat(24);
const firstLocation = "b".repeat(24);
const secondLocation = "c".repeat(24);

test("batch activation uses an idempotency key and unique lot identities", () => {
  const input = {
    action: "ACTIVATE",
    clientRequestId: crypto.randomUUID(),
    productId,
    expiryWarningDays: 30,
    openings: [
      { locationId: firstLocation, lotNo: "LOT-01", expiryDate: "2027-01-31", quantity: 4 },
      { locationId: secondLocation, lotNo: "LOT-01", expiryDate: "2027-01-31", quantity: 6 },
    ],
  };
  assert.equal(inventoryBatchActionSchema.safeParse(input).success, true);
  assert.equal(inventoryBatchActionSchema.safeParse({ ...input, openings: [input.openings[0], input.openings[0]] }).success, false);
  assert.equal(inventoryBatchActionSchema.safeParse({ ...input, clientRequestId: "retry" }).success, false);
});

test("batch counts require optimistic versions and whole quantities", () => {
  const valid = { action: "COUNT", clientRequestId: crypto.randomUUID(), batchId: productId, version: 2, countedQuantity: 8, reason: "Weekly shelf count" };
  assert.equal(inventoryBatchActionSchema.safeParse(valid).success, true);
  assert.equal(inventoryBatchActionSchema.safeParse({ ...valid, version: -1 }).success, false);
  assert.equal(inventoryBatchActionSchema.safeParse({ ...valid, countedQuantity: 1.5 }).success, false);
});

test("opening quantities reconcile by location", () => {
  const totals = openingTotalsByLocation([
    { locationId: firstLocation, quantity: 2 },
    { locationId: firstLocation, quantity: 3 },
    { locationId: secondLocation, quantity: 7 },
  ]);
  assert.equal(totals.get(firstLocation), 5);
  assert.equal(totals.get(secondLocation), 7);
});

test("batch identities normalize lot numbers without merging locations", () => {
  assert.equal(batchIdentityKey(firstLocation, " lot-01 ", "2027-01-31"), `${firstLocation}|LOT-01|2027-01-31`);
  assert.notEqual(batchIdentityKey(firstLocation, "LOT-01", "2027-01-31"), batchIdentityKey(secondLocation, "LOT-01", "2027-01-31"));
});

test("FEFO allocation consumes the earliest unexpired lots first", () => {
  const result = allocateFefo([
    { lotNo: "LATE", expiryDate: "2027-04-01", quantity: 5, createdAt: "2026-01-01" },
    { lotNo: "EARLY", expiryDate: "2027-02-01", quantity: 3, createdAt: "2026-02-01" },
  ], 6, "2027-01-01");
  assert.equal(result.shortage, 0);
  assert.deepEqual(result.allocations.map((allocation) => [allocation.lotNo, allocation.quantity]), [["EARLY", 3], ["LATE", 3]]);
});

test("FEFO allocation quarantines expired lots", () => {
  const result = allocateFefo([
    { lotNo: "OLD", expiryDate: "2026-12-31", quantity: 10 },
    { lotNo: "LIVE", expiryDate: "2027-02-01", quantity: 2 },
  ], 3, "2027-01-01");
  assert.equal(result.shortage, 1);
  assert.deepEqual(result.allocations.map((allocation) => allocation.lotNo), ["LIVE"]);
});

test("partial refunds restore the exact next slice of original batch allocations", () => {
  const original = [
    { lotNo: "A", lotKey: "A", expiryDate: "2027-01-01", quantity: 2 },
    { lotNo: "B", lotKey: "B", expiryDate: "2027-02-01", quantity: 4 },
  ];
  const result = sliceBatchAllocations(original, 1, 3);
  assert.equal(result.shortage, 0);
  assert.deepEqual(result.allocations.map((allocation) => [allocation.lotNo, allocation.quantity]), [["A", 1], ["B", 2]]);
});

test("expiry states are date-only and warning-window based", () => {
  assert.deepEqual(batchExpiryStatus("2027-01-09", "2027-01-10", 30), { daysRemaining: -1, status: "EXPIRED" });
  assert.deepEqual(batchExpiryStatus("2027-01-20", "2027-01-10", 10), { daysRemaining: 10, status: "EXPIRING" });
  assert.deepEqual(batchExpiryStatus("2027-02-10", "2027-01-10", 10), { daysRemaining: 31, status: "HEALTHY" });
});

test("freshness forecast assigns FEFO demand before marking later units at risk", () => {
  const forecast = forecastBatchFreshness([
    { id: "early", productId, locationId: firstLocation, quantity: 4, expiryDate: "2027-01-14" },
    { id: "late", productId, locationId: firstLocation, quantity: 5, expiryDate: "2027-01-19" },
  ], [{ productId, locationId: firstLocation, units: 30 }], "2027-01-10", 30);
  assert.equal(forecast.get("early")?.projectedAtRisk, 0);
  assert.equal(forecast.get("late")?.projectedAtRisk, 0);
  const slow = forecastBatchFreshness([
    { id: "slow", productId, locationId: firstLocation, quantity: 10, expiryDate: "2027-01-14" },
  ], [{ productId, locationId: firstLocation, units: 6 }], "2027-01-10", 30);
  assert.equal(slow.get("slow")?.projectedAtRisk, 9);
  assert.equal(slow.get("slow")?.forecastRisk, "HIGH");
});

test("freshness forecast suggests a higher-demand location without moving stock", () => {
  const forecast = forecastBatchFreshness([
    { id: "source", productId, locationId: firstLocation, quantity: 8, expiryDate: "2027-01-19" },
  ], [
    { productId, locationId: firstLocation, units: 3 },
    { productId, locationId: secondLocation, units: 60 },
  ], "2027-01-10", 30);
  assert.equal(forecast.get("source")?.suggestedLocationId, secondLocation);
  assert.ok(Number(forecast.get("source")?.suggestedTransferQuantity) > 0);
});

test("batch disposal requires controlled evidence and an optimistic version", () => {
  const valid = { action: "DISPOSE", clientRequestId: crypto.randomUUID(), batchId: productId, version: 0, quantity: 2, disposition: "EXPIRED", reason: "Past labelled expiry" };
  assert.equal(inventoryBatchActionSchema.safeParse(valid).success, true);
  assert.equal(inventoryBatchActionSchema.safeParse({ ...valid, quantity: 0 }).success, false);
  assert.equal(inventoryBatchActionSchema.safeParse({ ...valid, disposition: "SOLD" }).success, false);
});
