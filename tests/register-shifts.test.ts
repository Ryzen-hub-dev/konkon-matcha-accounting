import assert from "node:assert/strict";
import test from "node:test";
import {
  cashCountsSchema,
  registerShiftActionSchema,
  registerShiftOpenSchema,
  registerSummaryNeedsReview,
  summariseRegisterShift,
  type RegisterMovement,
} from "../lib/register-shifts";

const movements: RegisterMovement[] = [
  { direction: "SALE", paymentMethod: "CASH", paymentMethodName: "Cash", paymentKind: "CASH", baseAmount: 100, currency: "MYR", currencyAmount: 100, count: 2 },
  { direction: "SALE", paymentMethod: "CASH", paymentMethodName: "Cash", paymentKind: "CASH", baseAmount: 40, currency: "USD", currencyAmount: 10, count: 1 },
  { direction: "SALE", paymentMethod: "CARD", paymentMethodName: "Card", paymentKind: "NON_CASH", baseAmount: 50, currency: "MYR", currencyAmount: 50, count: 1 },
  { direction: "REFUND", paymentMethod: "CASH", paymentMethodName: "Cash", paymentKind: "CASH", baseAmount: 20, currency: "MYR", currencyAmount: 20, count: 1 },
];

test("register shifts reconcile base sales and physical cash by tender currency", () => {
  const summary = summariseRegisterShift({
    currency: "MYR",
    openingCash: [{ currency: "MYR", amount: 200 }, { currency: "USD", amount: 20 }],
    movements,
    countedCash: [{ currency: "MYR", amount: 279 }, { currency: "USD", amount: 30 }],
  });
  assert.equal(summary.saleCount, 4);
  assert.equal(summary.refundCount, 1);
  assert.equal(summary.grossSales, 190);
  assert.equal(summary.refunds, 20);
  assert.equal(summary.netSales, 170);
  assert.deepEqual(summary.cashByCurrency, [
    { currency: "MYR", openingFloat: 200, cashSales: 100, cashRefunds: 20, expectedCash: 280, countedCash: 279, variance: -1 },
    { currency: "USD", openingFloat: 20, cashSales: 10, cashRefunds: 0, expectedCash: 30, countedCash: 30, variance: 0 },
  ]);
  assert.equal(registerSummaryNeedsReview(summary), true);
  assert.deepEqual(summary.paymentBreakdown.map((payment) => ({ code: payment.code, sales: payment.sales, refunds: payment.refunds, net: payment.net })), [
    { code: "CARD", sales: 50, refunds: 0, net: 50 },
    { code: "CASH", sales: 140, refunds: 20, net: 120 },
  ]);
});

test("balanced blind counts close without a variance review", () => {
  const summary = summariseRegisterShift({
    currency: "MYR",
    openingCash: [{ currency: "MYR", amount: 200 }, { currency: "USD", amount: 20 }],
    movements,
    countedCash: [{ currency: "MYR", amount: 280 }, { currency: "USD", amount: 30 }],
  });
  assert.equal(registerSummaryNeedsReview(summary), false);
});

test("shift inputs require idempotency keys and unique valid currencies", () => {
  assert.equal(registerShiftOpenSchema.safeParse({ counterId: "a".repeat(24), clientRequestId: crypto.randomUUID(), openingCash: [{ currency: "myr", amount: 0 }] }).success, true);
  assert.equal(registerShiftOpenSchema.safeParse({ counterId: "a".repeat(24), openingCash: [{ currency: "MYR", amount: 0 }] }).success, false);
  assert.equal(cashCountsSchema.safeParse([{ currency: "MYR", amount: 1 }, { currency: "myr", amount: 2 }]).success, false);
  assert.equal(registerShiftActionSchema.safeParse({ action: "CLOSE", id: "b".repeat(24), clientRequestId: crypto.randomUUID(), countedCash: [{ currency: "MYR", amount: 10 }], note: "" }).success, true);
  assert.equal(registerShiftActionSchema.safeParse({ action: "APPROVE", id: "b".repeat(24), note: "" }).success, false);
});
