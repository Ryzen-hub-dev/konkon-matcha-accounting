import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  buildNinjaVanOrderPayload,
  ninjaVanRequestedTrackingNumber,
  verifyNinjaVanWebhook,
} from "../lib/ninja-van";

const order = {
  deliveryOrderNo: "DO-20260923-ABC123",
  contactName: "Aisha Tan",
  contactPhone: "+60123456789",
  contactEmail: "aisha@example.com",
  deliveryAddress1: "12 Jalan Matcha",
  deliveryAddress2: "Unit 3",
  deliveryArea: "Bangsar",
  deliveryCity: "Kuala Lumpur",
  deliveryState: "Wilayah Persekutuan",
  deliveryCountryCode: "MY",
  deliveryPostcode: "59100",
  serviceLevel: "Standard",
  pickupRequired: true,
  parcelWeight: 1.25,
  scheduledDate: "2026-09-24T00:00:00.000Z",
  instructions: "Keep upright",
  items: [{ description: "Matcha set", quantity: 2 }],
};

test("Ninja Van order payload uses a stable reference and documented domestic fields", () => {
  const payload = buildNinjaVanOrderPayload(order, { countryCode: "MY" });
  assert.equal(payload.service_type, "Parcel");
  assert.equal(payload.requested_tracking_number, ninjaVanRequestedTrackingNumber(order.deliveryOrderNo));
  assert.deepEqual(payload.reference, { merchant_order_number: order.deliveryOrderNo });
  assert.equal(payload.to.address.country, "MY");
  assert.equal(payload.to.address.postcode, "59100");
  assert.equal(payload.parcel_job.dimensions.weight, 1.25);
  assert.equal(payload.parcel_job.items[0].is_dangerous_good, false);
});

test("Ninja Van booking rejects a destination outside the connected domestic country", () => {
  assert.throws(
    () => buildNinjaVanOrderPayload(order, { countryCode: "SG" }),
    /accepts domestic SG orders/,
  );
});

test("Ninja Van webhook verification signs the exact raw body and rejects tampering", () => {
  const secret = "client-secret";
  const raw = '{"tracking_id":"NV123","timestamp":"2026-09-23T10:00:00+0800","status":"Pending Pickup"}';
  const signature = createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(verifyNinjaVanWebhook(raw, signature, secret), true);
  assert.equal(verifyNinjaVanWebhook(`${raw} `, signature, secret), false);
  assert.equal(verifyNinjaVanWebhook(raw, "not-a-signature", secret), false);
});
