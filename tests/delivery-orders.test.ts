import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDeliveryOrderAction, assertDeliveryOrderVersion, deliveryOrderActionSchema,
  deliveryOrderEditSchema, deliveryOrderEffectiveStatus, deliveryOrderInputSchema,
  nextDeliveryOrderUpdatedAt,
} from "../lib/delivery-orders";

const id = "1234567890abcdef12345678";
const version = "2026-09-18T12:15:30.123Z";

test("delivery-order creation validates its source, retry key and calendar date", () => {
  const parsed = deliveryOrderInputSchema.parse({ sourceQuoteId: id.toUpperCase(), scheduledDate: "2026-10-01", clientRequestId: "12345678-1234-4234-8234-123456789abc" });
  assert.equal(parsed.sourceQuoteId, id);
  assert.equal(parsed.scheduledDate.toISOString(), "2026-10-01T00:00:00.000Z");
  for (const scheduledDate of ["2026-02-30", "2026-10-01T12:00:00Z", "invalid"]) {
    assert.equal(deliveryOrderInputSchema.safeParse({ sourceQuoteId: id, scheduledDate }).success, false);
  }
  assert.equal(deliveryOrderInputSchema.safeParse({ sourceQuoteId: "bad", scheduledDate: "2026-10-01" }).success, false);
});

test("delivery-order draft edits require logistics data and an optimistic version", () => {
  const edit = { action: "EDIT_DRAFT", id, expectedUpdatedAt: version, scheduledDate: "2026-10-01", deliveryAddress: "1 Matcha Lane", contactName: "Aiko", contactPhone: "", carrierCode: "GDEX", carrier: "", trackingReference: "", instructions: "" };
  assert.equal(deliveryOrderEditSchema.safeParse(edit).success, true);
  assert.equal(deliveryOrderEditSchema.safeParse({ ...edit, trackingReference: "../../admin" }).success, false);
  for (const field of ["id", "expectedUpdatedAt", "scheduledDate"]) {
    const missing: Record<string, unknown> = { ...edit };
    delete missing[field];
    assert.equal(deliveryOrderEditSchema.safeParse(missing).success, false, field);
  }
  assert.doesNotThrow(() => assertDeliveryOrderVersion(new Date(version), version));
  assert.throws(() => assertDeliveryOrderVersion(new Date(version), "2026-09-18T12:15:30.122Z"), /another session/i);
  assert.equal(nextDeliveryOrderUpdatedAt(new Date(version), new Date(version)).toISOString(), "2026-09-18T12:15:30.124Z");
});

test("delivery-order actions require operational evidence", () => {
  assert.equal(deliveryOrderActionSchema.safeParse({ action: "DISPATCH", id, expectedUpdatedAt: version, note: "Handed to courier" }).success, true);
  assert.equal(deliveryOrderActionSchema.safeParse({ action: "DISPATCH", id, expectedUpdatedAt: version, note: "" }).success, false);
  assert.equal(deliveryOrderActionSchema.safeParse({ action: "DELIVER", id, expectedUpdatedAt: version, note: "Reported delivered", receivedBy: "Aiko" }).success, true);
  assert.equal(deliveryOrderActionSchema.safeParse({ action: "DELIVER", id, expectedUpdatedAt: version, note: "Reported delivered" }).success, false);
  assert.equal(deliveryOrderActionSchema.safeParse({ action: "CANCEL", id, note: "Customer request" }).success, false);
});

test("delivery-order workflow is forward-only and dispatch needs a destination", () => {
  const ready = { status: "DRAFT", deliveryAddress: "1 Matcha Lane", contactName: "Aiko" };
  assert.doesNotThrow(() => assertDeliveryOrderAction(ready, "DISPATCH"));
  assert.doesNotThrow(() => assertDeliveryOrderAction({ status: "DISPATCHED" }, "DELIVER"));
  assert.doesNotThrow(() => assertDeliveryOrderAction({ status: "DRAFT" }, "CANCEL"));
  assert.doesNotThrow(() => assertDeliveryOrderAction({ status: "DISPATCHED" }, "CANCEL"));
  assert.throws(() => assertDeliveryOrderAction({ ...ready, deliveryAddress: "" }, "DISPATCH"), /address/i);
  assert.throws(() => assertDeliveryOrderAction({ ...ready, contactName: "" }, "DISPATCH"), /contact/i);
  assert.throws(() => assertDeliveryOrderAction({ status: "DELIVERED" }, "CANCEL"), /cannot/i);
  assert.throws(() => assertDeliveryOrderAction({ status: "DRAFT" }, "DELIVER"), /cannot/i);
});

test("open late delivery orders expose an overdue state without rewriting history", () => {
  assert.equal(deliveryOrderEffectiveStatus("DRAFT", "2026-09-17T00:00:00.000Z", "2026-09-18"), "OVERDUE");
  assert.equal(deliveryOrderEffectiveStatus("DISPATCHED", "2026-09-17T00:00:00.000Z", "2026-09-18"), "OVERDUE");
  assert.equal(deliveryOrderEffectiveStatus("DRAFT", "2026-09-18T00:00:00.000Z", "2026-09-18"), "DRAFT");
  assert.equal(deliveryOrderEffectiveStatus("DELIVERED", "2026-09-01T00:00:00.000Z", "2026-09-18"), "DELIVERED");
});
