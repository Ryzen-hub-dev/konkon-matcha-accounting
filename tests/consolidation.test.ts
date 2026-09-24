import assert from "node:assert/strict";
import test from "node:test";
import { consolidateGroup, consolidationInputSchema } from "../lib/consolidation";

const entity = {
  entityCode: "MY-SUB",
  entityName: "Malaysia Subsidiary",
  countryCode: "MY",
  functionalCurrency: "MYR",
  closingRate: 0.2,
  averageRate: 0.25,
  rows: [
    { accountCode: "1000", accountName: "Cash", accountType: "ASSET" as const, debit: 1_000, credit: 0 },
    { accountCode: "3000", accountName: "Equity", accountType: "EQUITY" as const, debit: 0, credit: 700 },
    { accountCode: "4000", accountName: "Revenue", accountType: "REVENUE" as const, debit: 0, credit: 500 },
    { accountCode: "5000", accountName: "Expense", accountType: "EXPENSE" as const, debit: 200, credit: 0 },
  ],
};

test("group consolidation translates closing and average-rate accounts and balances CTA", () => {
  const result = consolidateGroup([entity], [], "SGD");
  assert.equal(result.totalDebit, 265);
  assert.equal(result.totalCredit, 265);
  assert.equal(result.entities[0].translationReserve, -15);
  const reserve = result.rows.find(row => row.accountCode === "3999");
  assert.equal(reserve?.debit, 15);
  assert.equal(result.rows.find(row => row.accountCode === "1000")?.debit, 200);
  assert.equal(result.rows.find(row => row.accountCode === "4000")?.credit, 125);
});

test("group eliminations must balance in reporting currency", () => {
  assert.throws(() => consolidateGroup([entity], [{
    reference: "IC-1", reason: "Remove intercompany sale",
    lines: [
      { accountCode: "4000", accountName: "Revenue", accountType: "REVENUE", debit: 10, credit: 0 },
      { accountCode: "5000", accountName: "Expense", accountType: "EXPENSE", debit: 0, credit: 9 },
    ],
  }], "SGD"), /not balanced/);
});

test("consolidation requests require unique entity codes and a valid period", () => {
  const parsed = consolidationInputSchema.safeParse({
    clientRequestId: "b049ae12-9484-4a8b-a8a9-139c01774904",
    periodFrom: "2026-12-31", periodTo: "2026-01-01", reportingCurrency: "SGD",
    currentEntityCode: "MY-SUB", currentEntityClosingRate: 1, currentEntityAverageRate: 1,
    importedEntities: [entity], eliminations: [], reviewNote: "Reviewed rates",
  });
  assert.equal(parsed.success, false);
});
