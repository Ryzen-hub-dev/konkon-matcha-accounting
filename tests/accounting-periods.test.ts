import assert from "node:assert/strict";
import test from "node:test";
import {
  accountingPeriodActionSchema, accountingPeriodBounds, accountingPeriodSnapshotChanged, assertAccountingPeriodVersion,
  assertCompletedAccountingPeriod, buildPeriodChecklist, nextAccountingPeriodUpdatedAt,
  periodKeyFromDateKey, shiftAccountingPeriod,
} from "../lib/accounting-periods";

const version = "2026-09-18T12:15:30.123Z";

test("accounting period keys and leap-month boundaries are calendar safe", () => {
  assert.equal(periodKeyFromDateKey("2026-09-18"), "2026-09");
  assert.equal(shiftAccountingPeriod("2026-01", -1), "2025-12");
  assert.equal(shiftAccountingPeriod("2025-12", 2), "2026-02");
  assert.deepEqual(accountingPeriodBounds("2028-02"), {
    startKey: "2028-02-01", endKey: "2028-02-29",
    start: new Date("2028-02-01T00:00:00.000Z"), end: new Date("2028-02-29T23:59:59.999Z"),
  });
  assert.throws(() => periodKeyFromDateKey("2026/09/18"), /business date/i);
});

test("only completed calendar months may close", () => {
  assert.doesNotThrow(() => assertCompletedAccountingPeriod("2026-08", "2026-09"));
  assert.throws(() => assertCompletedAccountingPeriod("2026-09", "2026-09"), /completed calendar month/i);
  assert.throws(() => assertCompletedAccountingPeriod("2026-10", "2026-09"), /completed calendar month/i);
});

test("period close and reopen actions require review evidence", () => {
  assert.equal(accountingPeriodActionSchema.safeParse({ action: "CLOSE", periodKey: "2026-08", note: "Reviewed by accountant" }).success, true);
  assert.equal(accountingPeriodActionSchema.safeParse({ action: "REOPEN", periodKey: "2026-08", note: "" }).success, false);
  assert.equal(accountingPeriodActionSchema.safeParse({ action: "CLOSE", periodKey: "2026-13", note: "Reviewed" }).success, false);
});

test("month-end checklist exposes journal and bank blockers", () => {
  const blocked = buildPeriodChecklist({
    journalCount: 12, totalDebit: 100, totalCredit: 99, unbalancedCount: 1,
    requiredBankAccounts: [{ code: "1010", name: "Bank" }, { code: "1020", name: "Savings" }],
    reconciledBankCodes: ["1010"], openBankReconciliationCount: 1, fixedAssetDueCount: 2,
  }, "MYR");
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.length, 5);
  assert.deepEqual(blocked.missingBankAccounts, [{ code: "1020", name: "Savings" }]);

  const ready = buildPeriodChecklist({
    journalCount: 12, totalDebit: 100, totalCredit: 100, unbalancedCount: 0,
    requiredBankAccounts: [{ code: "1010", name: "Bank" }],
    reconciledBankCodes: ["1010"], openBankReconciliationCount: 0,
  }, "MYR");
  assert.equal(ready.ready, true);
  assert.equal(ready.fixedAssetDueCount, 0);
  assert.deepEqual(ready.blockers, []);
});

test("period optimistic versions detect conflicts and advance monotonically", () => {
  assert.doesNotThrow(() => assertAccountingPeriodVersion(new Date(version), version));
  assert.throws(() => assertAccountingPeriodVersion(new Date(version), "2026-09-18T12:15:30.122Z"), /another session/i);
  assert.equal(nextAccountingPeriodUpdatedAt(new Date(version), new Date(version)).toISOString(), "2026-09-18T12:15:30.124Z");
});

test("locked period snapshots detect out-of-band ledger changes", () => {
  const snapshot = { journalCount: 4, totalDebit: 125.5, totalCredit: 125.5 };
  assert.equal(accountingPeriodSnapshotChanged(snapshot, { journalCount: 4, totalDebit: 125.5, totalCredit: 125.5 }, "MYR"), false);
  assert.equal(accountingPeriodSnapshotChanged(snapshot, { journalCount: 5, totalDebit: 125.5, totalCredit: 125.5 }, "MYR"), true);
  assert.equal(accountingPeriodSnapshotChanged(snapshot, { journalCount: 4, totalDebit: 125.51, totalCredit: 125.5 }, "MYR"), true);
});
