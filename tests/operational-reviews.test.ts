import assert from "node:assert/strict";
import test from "node:test";
import {
  assessInventoryAdjustment,
  assessManualDiscount,
  assessRefund,
  assessRegisterVariance,
  assessStocktakeShrinkage,
  operationalReviewActionSchema,
  repeatedLoginFailureReview,
} from "../lib/operational-reviews";

test("manual discount reviews start at ten percent and escalate at twenty-five percent", () => {
  assert.equal(assessManualDiscount({ subtotal: 100, manualDiscount: 9.99 }), null);
  assert.equal(assessManualDiscount({ subtotal: 100, manualDiscount: 10 })?.severity, "MEDIUM");
  assert.equal(assessManualDiscount({ subtotal: 100, manualDiscount: 25 })?.severity, "HIGH");
});

test("refund reviews use cumulative receipt exposure", () => {
  assert.equal(assessRefund({ saleTotal: 100, refundTotal: 20, cumulativeRefundTotal: 49 }), null);
  assert.equal(assessRefund({ saleTotal: 100, refundTotal: 20, cumulativeRefundTotal: 50 })?.severity, "MEDIUM");
  assert.equal(assessRefund({ saleTotal: 100, refundTotal: 10, cumulativeRefundTotal: 90 })?.severity, "HIGH");
});

test("negative inventory changes consider both unit and proportional loss", () => {
  assert.equal(assessInventoryAdjustment({ currentStock: 100, adjustment: -4 }), null);
  assert.equal(assessInventoryAdjustment({ currentStock: 10, adjustment: -1 })?.severity, "MEDIUM");
  assert.equal(assessInventoryAdjustment({ currentStock: 20, adjustment: -5 })?.severity, "HIGH");
  assert.equal(assessInventoryAdjustment({ currentStock: 20, adjustment: 20 }), null);
});

test("stocktake shrinkage ignores gains and aggregates missing units", () => {
  assert.equal(assessStocktakeShrinkage([{ bookStock: 20, difference: 3 }]), null);
  const review = assessStocktakeShrinkage([{ bookStock: 100, difference: -3 }, { bookStock: 100, difference: -2 }]);
  assert.equal(review?.unitCount, 5);
  assert.equal(review?.severity, "MEDIUM");
});

test("register and sign-in rules flag controlled exceptions", () => {
  assert.equal(assessRegisterVariance([{ currency: "MYR", expectedCash: 100, variance: 0 }]), null);
  assert.equal(assessRegisterVariance([{ currency: "MYR", expectedCash: 100, variance: -5 }])?.severity, "HIGH");
  assert.equal(repeatedLoginFailureReview(4), null);
  assert.equal(repeatedLoginFailureReview(5)?.category, "SECURITY");
});

test("review actions require optimistic versions and resolution evidence", () => {
  const id = "a".repeat(24);
  assert.equal(operationalReviewActionSchema.safeParse({ action: "ACKNOWLEDGE", id, version: 0, note: "" }).success, true);
  assert.equal(operationalReviewActionSchema.safeParse({ action: "RESOLVE", id, version: 0, note: "" }).success, false);
  assert.equal(operationalReviewActionSchema.safeParse({ action: "RESOLVE", id, version: 2, note: "Receipt checked" }).success, true);
  assert.equal(operationalReviewActionSchema.safeParse({ action: "REOPEN", id, note: "Needs another check" }).success, false);
});
