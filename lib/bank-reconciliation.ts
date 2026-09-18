import { z } from "zod";
import { isValidDateKey } from "@/lib/dates";
import { currencyFractionDigits, currencyMinorUnits, roundCurrency } from "@/lib/international";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid record.").transform(value => value.toLowerCase());
const dateKeySchema = z.string().trim().refine(value => isValidDateKey(value), "Use YYYY-MM-DD for every date.");

const statementRowSchema = z.object({
  date: dateKeySchema,
  description: z.string().trim().min(2).max(200),
  reference: z.string().trim().max(100).default(""),
  amount: z.coerce.number().finite().refine(value => value !== 0, "Statement amounts cannot be zero.").refine(value => Math.abs(value) <= 100_000_000, "The statement amount is too large."),
});

export const bankReconciliationInputSchema = z.object({
  accountCode: z.string().trim().min(3).max(12),
  statementStartDate: dateKeySchema,
  statementDate: dateKeySchema,
  openingBalance: z.coerce.number().finite().min(-100_000_000).max(100_000_000),
  closingBalance: z.coerce.number().finite().min(-100_000_000).max(100_000_000),
  rows: z.array(statementRowSchema).min(1).max(500),
  clientRequestId: z.string().uuid().optional(),
}).superRefine((value, context) => {
  if (value.statementStartDate > value.statementDate) {
    context.addIssue({ code: "custom", path: ["statementStartDate"], message: "The statement start date must not be after its closing date." });
  }
  value.rows.forEach((row, index) => {
    if (row.date < value.statementStartDate || row.date > value.statementDate) {
      context.addIssue({ code: "custom", path: ["rows", index, "date"], message: "Every transaction must fall inside the statement period." });
    }
  });
});

export const bankReconciliationActionSchema = z.object({
  action: z.enum(["MATCH", "UNMATCH", "COMPLETE", "VOID"]),
  id: objectIdSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  rowId: objectIdSchema.optional(),
  journalEntryId: objectIdSchema.optional(),
  lineIndex: z.coerce.number().int().min(0).max(100).optional(),
  note: z.string().trim().max(300).default(""),
}).superRefine((value, context) => {
  if (["MATCH", "UNMATCH"].includes(value.action) && !value.rowId) {
    context.addIssue({ code: "custom", path: ["rowId"], message: "Choose a bank-statement row." });
  }
  if (value.action === "MATCH" && (!value.journalEntryId || value.lineIndex === undefined)) {
    context.addIssue({ code: "custom", path: ["journalEntryId"], message: "Choose a ledger transaction." });
  }
  if (["COMPLETE", "VOID"].includes(value.action) && value.note.length < 3) {
    context.addIssue({ code: "custom", path: ["note"], message: "Record a short review note or reason." });
  }
});

export class BankReconciliationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export type ParsedBankRow = { date: string; description: string; reference: string; amount: number };

function csvRecords(text: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") { record.push(field); field = ""; }
    else if (character === "\n") { record.push(field.replace(/\r$/, "")); records.push(record); record = []; field = ""; }
    else field += character;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted field.");
  if (field.length || record.length) { record.push(field.replace(/\r$/, "")); records.push(record); }
  return records.filter(row => row.some(value => value.trim().length));
}

function normaliseHeader(value: string) {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function parseStatementNumber(value: string, label: string) {
  const source = value.trim();
  if (!source) return 0;
  const negative = /^\(.*\)$/.test(source) || source.endsWith("-");
  const cleaned = source.replace(/[(),\s]/g, "").replace(/-$/, "").replace(/^[A-Za-z$€£¥]+/, "");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) throw new Error(`${label} contains an invalid amount: ${value}`);
  return negative ? -Math.abs(amount) : amount;
}

export function parseBankStatementCsv(text: string): ParsedBankRow[] {
  if (text.length > 1_000_000) throw new Error("The CSV is too large. Import at most 500 rows at a time.");
  const records = csvRecords(text);
  if (records.length < 2) throw new Error("The CSV needs a header and at least one transaction.");
  const headers = records[0].map(normaliseHeader);
  const find = (...names: string[]) => headers.findIndex(header => names.includes(header));
  const dateIndex = find("date", "transactiondate", "valuedate");
  const descriptionIndex = find("description", "details", "narrative", "memo");
  const referenceIndex = find("reference", "ref", "transactionreference");
  const amountIndex = find("amount", "signedamount");
  const debitIndex = find("debit", "withdrawal", "moneyout");
  const creditIndex = find("credit", "deposit", "moneyin");
  if (dateIndex < 0 || descriptionIndex < 0 || (amountIndex < 0 && debitIndex < 0 && creditIndex < 0)) {
    throw new Error("Use headers date, description, reference and amount; or replace amount with debit and credit columns.");
  }
  const rows = records.slice(1).map((record, index) => {
    const date = String(record[dateIndex] || "").trim();
    if (!isValidDateKey(date)) throw new Error(`Row ${index + 2} has an invalid date. Use YYYY-MM-DD.`);
    const description = String(record[descriptionIndex] || "").trim();
    if (description.length < 2 || description.length > 200) throw new Error(`Row ${index + 2} needs a description between 2 and 200 characters.`);
    const reference = referenceIndex >= 0 ? String(record[referenceIndex] || "").trim() : "";
    if (reference.length > 100) throw new Error(`Row ${index + 2} has a reference longer than 100 characters.`);
    const amount = amountIndex >= 0
      ? parseStatementNumber(String(record[amountIndex] || ""), `Row ${index + 2}`)
      : Math.abs(parseStatementNumber(String(record[creditIndex] || ""), `Row ${index + 2} credit`))
        - Math.abs(parseStatementNumber(String(record[debitIndex] || ""), `Row ${index + 2} debit`));
    if (!amount) throw new Error(`Row ${index + 2} must contain a non-zero amount.`);
    return { date, description, reference, amount };
  });
  if (rows.length > 500) throw new Error("Import at most 500 statement rows at a time.");
  return rows;
}

export function statementMovement(rows: Array<{ amount: number }>, currency: string) {
  const units = rows.reduce((sum, row) => sum + currencyMinorUnits(row.amount, currency), 0);
  return roundCurrency(units / (10 ** currencyFractionDigits(currency)), currency);
}

export function assertStatementArithmetic(openingBalance: number, closingBalance: number, rows: Array<{ amount: number }>, currency: string) {
  const openingUnits = currencyMinorUnits(openingBalance, currency);
  const closingUnits = currencyMinorUnits(closingBalance, currency);
  const movementUnits = rows.reduce((sum, row) => sum + currencyMinorUnits(row.amount, currency), 0);
  if (openingUnits + movementUnits !== closingUnits) {
    const difference = roundCurrency((openingUnits + movementUnits - closingUnits) / (10 ** currencyFractionDigits(currency)), currency);
    throw new BankReconciliationError(`The opening balance plus CSV transactions differs from the closing balance by ${difference} ${currency}.`, 422);
  }
}

export function signedBankLine(line: { debit?: unknown; credit?: unknown }, currency: string) {
  return roundCurrency(Number(line.debit || 0) - Number(line.credit || 0), currency);
}

export function bankReconciliationSummary(values: {
  ledgerOpeningBalance: number; ledgerClosingBalance: number; statementOpeningBalance: number; statementClosingBalance: number;
  unmatchedCurrent: Array<{ amount: number }>; matchedPrior: Array<{ amount: number }>;
}, currency: string) {
  const openingDifferenceUnits = currencyMinorUnits(values.ledgerOpeningBalance, currency) - currencyMinorUnits(values.statementOpeningBalance, currency);
  const unmatchedCurrentUnits = values.unmatchedCurrent.reduce((sum, line) => sum + currencyMinorUnits(line.amount, currency), 0);
  const matchedPriorUnits = values.matchedPrior.reduce((sum, line) => sum + currencyMinorUnits(line.amount, currency), 0);
  const adjustedStatementUnits = currencyMinorUnits(values.statementClosingBalance, currency) + openingDifferenceUnits + unmatchedCurrentUnits - matchedPriorUnits;
  const differenceUnits = currencyMinorUnits(values.ledgerClosingBalance, currency) - adjustedStatementUnits;
  const scale = 10 ** currencyFractionDigits(currency);
  return {
    openingDifference: roundCurrency(openingDifferenceUnits / scale, currency),
    unmatchedCurrentNet: roundCurrency(unmatchedCurrentUnits / scale, currency),
    matchedPriorNet: roundCurrency(matchedPriorUnits / scale, currency),
    adjustedStatementBalance: roundCurrency(adjustedStatementUnits / scale, currency),
    difference: roundCurrency(differenceUnits / scale, currency),
  };
}

export function assertBankMatch(statementAmount: number, line: { debit?: unknown; credit?: unknown }, currency: string) {
  if (currencyMinorUnits(statementAmount, currency) !== currencyMinorUnits(signedBankLine(line, currency), currency)) {
    throw new BankReconciliationError("The bank row and ledger transaction amounts do not match.", 422);
  }
}

export function assertBankReconciliationVersion(updatedAt: unknown, expectedUpdatedAt: string) {
  const current = updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
  if (!Number.isFinite(current) || current !== new Date(expectedUpdatedAt).getTime()) {
    throw new BankReconciliationError("This reconciliation changed in another session. Refresh it before trying again.");
  }
}

export function nextBankReconciliationUpdatedAt(previous: unknown, now = new Date()) {
  const old = previous instanceof Date ? previous.getTime() : new Date(String(previous)).getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(old) ? old + 1 : 0));
}

export function suggestBankMatches(
  rows: Array<{ rowId: string; date: string; amount: number; matchedJournalEntryId?: unknown }>,
  candidates: Array<{ key: string; businessDate: string; amount: number }>, currency: string,
) {
  const used = new Set<string>();
  const suggestions: Record<string, string> = {};
  for (const row of rows) {
    if (row.matchedJournalEntryId) continue;
    const exact = candidates.filter(candidate => !used.has(candidate.key)
      && candidate.businessDate === row.date
      && currencyMinorUnits(candidate.amount, currency) === currencyMinorUnits(row.amount, currency));
    if (exact.length === 1) { suggestions[row.rowId] = exact[0].key; used.add(exact[0].key); continue; }
    const rowTime = Date.parse(`${row.date}T00:00:00.000Z`);
    const near = candidates.filter(candidate => !used.has(candidate.key)
      && Math.abs(Date.parse(`${candidate.businessDate}T00:00:00.000Z`) - rowTime) <= 3 * 86_400_000
      && currencyMinorUnits(candidate.amount, currency) === currencyMinorUnits(row.amount, currency));
    if (near.length === 1) { suggestions[row.rowId] = near[0].key; used.add(near[0].key); }
  }
  return suggestions;
}
