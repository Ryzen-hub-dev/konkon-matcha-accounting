import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBankMatch, assertBankReconciliationVersion, assertStatementArithmetic,
  bankReconciliationActionSchema, bankReconciliationInputSchema, bankReconciliationSummary,
  nextBankReconciliationUpdatedAt, parseBankStatementCsv, signedBankLine,
  statementMovement, suggestBankMatches,
} from "../lib/bank-reconciliation";

const id = "1234567890abcdef12345678";
const version = "2026-09-18T12:15:30.123Z";

test("bank CSV import accepts quoted fields and signed amount rows", () => {
  const rows = parseBankStatementCsv([
    "date,description,reference,amount",
    '2026-09-01,"Customer, transfer",TXN-1,"1,250.50"',
    "2026-09-02,Bank charge,FEE-1,(2.50)",
  ].join("\n"));
  assert.deepEqual(rows, [
    { date: "2026-09-01", description: "Customer, transfer", reference: "TXN-1", amount: 1250.5 },
    { date: "2026-09-02", description: "Bank charge", reference: "FEE-1", amount: -2.5 },
  ]);
  assert.equal(statementMovement(rows, "MYR"), 1248);
});

test("bank CSV import normalises debit and credit columns", () => {
  const rows = parseBankStatementCsv([
    "value date,narrative,withdrawal,deposit",
    "2026-09-01,Card settlement,,100.00",
    "2026-09-02,Merchant fee,(2.00),",
  ].join("\n"));
  assert.deepEqual(rows.map(row => row.amount), [100, -2]);
});

test("bank CSV import rejects ambiguous or incomplete evidence", () => {
  assert.throws(() => parseBankStatementCsv("date,description,amount\n01/09/2026,Deposit,10"), /YYYY-MM-DD/i);
  assert.throws(() => parseBankStatementCsv("date,description\n2026-09-01,Deposit"), /headers/i);
  assert.throws(() => parseBankStatementCsv("date,description,amount\n2026-09-01,Deposit,0"), /non-zero/i);
  assert.throws(() => parseBankStatementCsv('date,description,amount\n2026-09-01,"Deposit,10'), /unclosed/i);
});

test("reconciliation input keeps every row inside its statement period", () => {
  const base = {
    accountCode: "1010", statementStartDate: "2026-09-01", statementDate: "2026-09-30",
    openingBalance: 100, closingBalance: 110,
    rows: [{ date: "2026-09-10", description: "Deposit", reference: "", amount: 10 }],
  };
  assert.equal(bankReconciliationInputSchema.safeParse(base).success, true);
  assert.equal(bankReconciliationInputSchema.safeParse({ ...base, statementStartDate: "2026-10-01" }).success, false);
  assert.equal(bankReconciliationInputSchema.safeParse({ ...base, rows: [{ ...base.rows[0], date: "2026-08-31" }] }).success, false);
});

test("statement arithmetic and bank-line signs use currency minor units", () => {
  assert.doesNotThrow(() => assertStatementArithmetic(100, 108.75, [{ amount: 10 }, { amount: -1.25 }], "MYR"));
  assert.throws(() => assertStatementArithmetic(100, 108.74, [{ amount: 10 }, { amount: -1.25 }], "MYR"), /differs/i);
  assert.equal(signedBankLine({ debit: 125, credit: 2.5 }, "MYR"), 122.5);
  assert.doesNotThrow(() => assertBankMatch(122.5, { debit: 125, credit: 2.5 }, "MYR"));
  assert.throws(() => assertBankMatch(122.49, { debit: 125, credit: 2.5 }, "MYR"), /do not match/i);
});

test("automatic bank matches remain unique suggestions", () => {
  const rows = [
    { rowId: "row-1", date: "2026-09-10", amount: 100 },
    { rowId: "row-2", date: "2026-09-11", amount: 50 },
    { rowId: "row-3", date: "2026-09-20", amount: 25 },
  ];
  const suggestions = suggestBankMatches(rows, [
    { key: "entry-1", businessDate: "2026-09-10", amount: 100 },
    { key: "entry-2", businessDate: "2026-09-12", amount: 50 },
    { key: "entry-3", businessDate: "2026-09-19", amount: 25 },
    { key: "entry-4", businessDate: "2026-09-21", amount: 25 },
  ], "MYR");
  assert.deepEqual(suggestions, { "row-1": "entry-1", "row-2": "entry-2" });
});

test("reconciliation summary carries prior and current uncleared items", () => {
  const summary = bankReconciliationSummary({
    ledgerOpeningBalance: 1100, ledgerClosingBalance: 1300,
    statementOpeningBalance: 1000, statementClosingBalance: 1250,
    unmatchedCurrent: [{ amount: 50 }], matchedPrior: [{ amount: 100 }],
  }, "MYR");
  assert.deepEqual(summary, {
    openingDifference: 100, unmatchedCurrentNet: 50, matchedPriorNet: 100,
    adjustedStatementBalance: 1300, difference: 0,
  });
});

test("bank actions require optimistic versions and completion evidence", () => {
  assert.equal(bankReconciliationActionSchema.safeParse({ action: "MATCH", id, expectedUpdatedAt: version, rowId: id, journalEntryId: id, lineIndex: 0 }).success, true);
  assert.equal(bankReconciliationActionSchema.safeParse({ action: "MATCH", id, expectedUpdatedAt: version, rowId: id }).success, false);
  assert.equal(bankReconciliationActionSchema.safeParse({ action: "COMPLETE", id, expectedUpdatedAt: version, note: "Reviewed" }).success, true);
  assert.equal(bankReconciliationActionSchema.safeParse({ action: "COMPLETE", id, expectedUpdatedAt: version, note: "" }).success, false);
  assert.doesNotThrow(() => assertBankReconciliationVersion(new Date(version), version));
  assert.throws(() => assertBankReconciliationVersion(new Date(version), "2026-09-18T12:15:30.122Z"), /another session/i);
  assert.equal(nextBankReconciliationUpdatedAt(new Date(version), new Date(version)).toISOString(), "2026-09-18T12:15:30.124Z");
});
