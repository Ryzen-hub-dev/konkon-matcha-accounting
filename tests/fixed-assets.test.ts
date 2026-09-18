import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFixedAssetVersion, depreciationPostingAmount, fixedAssetDepreciationDue, fixedAssetDisposalAmounts,
  fixedAssetInputSchema, fixedAssetPeriodIndex, nextFixedAssetDepreciationPeriod, nextFixedAssetUpdatedAt,
  scheduledDepreciationAmount,
} from "../lib/fixed-assets";

const base = {
  cost: 1_000, residualValue: 100, usefulLifeMonths: 3, accumulatedDepreciation: 0,
  inServiceDate: "2026-01-10", status: "ACTIVE",
};

test("fixed asset inputs separate cash purchases from register-only migration evidence", () => {
  const common = {
    clientRequestId: crypto.randomUUID(), name: "Espresso machine", category: "Equipment",
    purchaseDate: "2026-01-02", inServiceDate: "2026-01-10", cost: 1_000, residualValue: 100,
    usefulLifeMonths: 36, assetAccountCode: "1500", accumulatedDepreciationAccountCode: "1510",
    depreciationExpenseAccountCode: "6300", gainAccountCode: "4300", lossAccountCode: "6400",
  };
  assert.equal(fixedAssetInputSchema.safeParse({ ...common, acquisitionMode: "CASH_PURCHASE", paymentAccountCode: "1010" }).success, true);
  assert.equal(fixedAssetInputSchema.safeParse({ ...common, acquisitionMode: "CASH_PURCHASE", paymentAccountCode: "" }).success, false);
  assert.equal(fixedAssetInputSchema.safeParse({ ...common, acquisitionMode: "REGISTER_ONLY", openingAccumulatedDepreciation: 200, openingThroughPeriod: "2025-12" }).success, false);
  assert.equal(fixedAssetInputSchema.safeParse({ ...common, acquisitionMode: "REGISTER_ONLY", openingAccumulatedDepreciation: 200, openingThroughPeriod: "2026-03" }).success, true);
});

test("straight-line depreciation allocates exact currency units and uses full service month", () => {
  assert.equal(fixedAssetPeriodIndex(base.inServiceDate, "2026-01"), 0);
  assert.equal(scheduledDepreciationAmount(base, "2026-01", "MYR"), 300);
  assert.equal(scheduledDepreciationAmount(base, "2026-02", "MYR"), 300);
  assert.equal(scheduledDepreciationAmount(base, "2026-03", "MYR"), 300);
  assert.equal(scheduledDepreciationAmount(base, "2026-04", "MYR"), 0);
});

test("minor-unit remainder is distributed without losing or inventing value", () => {
  const asset = { ...base, cost: 1, residualValue: 0, usefulLifeMonths: 3 };
  const amounts = ["2026-01", "2026-02", "2026-03"].map(period => scheduledDepreciationAmount(asset, period, "MYR"));
  assert.deepEqual(amounts, [0.34, 0.33, 0.33]);
  assert.equal(amounts.reduce((sum, value) => sum + value, 0), 1);
});

test("depreciation stays sequential and caps at residual value", () => {
  assert.equal(nextFixedAssetDepreciationPeriod(base), "2026-01");
  assert.equal(fixedAssetDepreciationDue(base, "2026-01", "MYR"), true);
  const advanced = { ...base, accumulatedDepreciation: 300, lastDepreciationPeriod: "2026-01" };
  assert.equal(nextFixedAssetDepreciationPeriod(advanced), "2026-02");
  assert.equal(fixedAssetDepreciationDue(advanced, "2026-01", "MYR"), false);
  assert.equal(depreciationPostingAmount({ ...advanced, accumulatedDepreciation: 850 }, "2026-02", "MYR"), 25);
  assert.equal(depreciationPostingAmount({ ...advanced, accumulatedDepreciation: 200 }, "2026-02", "MYR"), 350);
});

test("asset disposal separates proceeds, net book value and gain or loss", () => {
  assert.deepEqual(fixedAssetDisposalAmounts({ ...base, accumulatedDepreciation: 600 }, 450, "MYR"), {
    cost: 1_000, accumulatedDepreciation: 600, netBookValue: 400, proceeds: 450, gain: 50, loss: 0,
  });
  assert.deepEqual(fixedAssetDisposalAmounts({ ...base, accumulatedDepreciation: 600 }, 250, "MYR"), {
    cost: 1_000, accumulatedDepreciation: 600, netBookValue: 400, proceeds: 250, gain: 0, loss: 150,
  });
});

test("fixed asset optimistic timestamps reject stale writes", () => {
  const stamp = "2026-09-18T12:15:30.123Z";
  assert.doesNotThrow(() => assertFixedAssetVersion(new Date(stamp), stamp));
  assert.throws(() => assertFixedAssetVersion(new Date(stamp), "2026-09-18T12:15:30.122Z"), /another session/i);
  assert.equal(nextFixedAssetUpdatedAt(new Date(stamp), new Date(stamp)).toISOString(), "2026-09-18T12:15:30.124Z");
});
