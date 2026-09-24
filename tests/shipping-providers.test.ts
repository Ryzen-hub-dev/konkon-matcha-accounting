import assert from "node:assert/strict";
import test from "node:test";
import {
  findShippingProvider, normaliseCarrierSelection, resolveTrackingLinks, trackingLinkRequestSchema,
} from "../lib/shipping-providers";

test("shipping provider aliases preserve the current ABX brand and legacy KEX input", () => {
  assert.equal(findShippingProvider("gd express").id, "GDEX");
  assert.equal(findShippingProvider("KEX Express").id, "ABX");
  assert.equal(findShippingProvider("ninjavan").id, "NINJA_VAN");
  assert.equal(findShippingProvider("Local rider").id, "OTHER");
});

test("tracking handoff rejects unsafe references and removes exact duplicates", () => {
  const parsed = trackingLinkRequestSchema.parse({ provider: "KEX", trackingReferences: ["RTX000000010001", "RTX000000010001"] });
  const resolved = resolveTrackingLinks(parsed);
  assert.equal(resolved.provider.id, "ABX");
  assert.deepEqual(resolved.trackingReferences, ["RTX000000010001"]);
  assert.equal(new URL(resolved.trackingUrl).protocol, "https:");
  for (const reference of ["abc", "../../admin", "ABC 123", "<script>"]) {
    assert.equal(trackingLinkRequestSchema.safeParse({ provider: "GDEX", trackingReferences: [reference] }).success, false, reference);
  }
});

test("known carriers use canonical names while manual carriers retain the entered name", () => {
  assert.deepEqual(normaliseCarrierSelection("mygdex", "ignored"), { carrierCode: "GDEX", carrier: "GDEX" });
  assert.deepEqual(normaliseCarrierSelection("OTHER", "  Local rider  "), { carrierCode: "OTHER", carrier: "Local rider" });
});
