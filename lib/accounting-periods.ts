import { z } from "zod";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";

export const accountingPeriodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a valid accounting month.");

export const accountingPeriodActionSchema = z.object({
  action: z.enum(["CLOSE", "REOPEN"]),
  periodKey: accountingPeriodKeySchema,
  note: z.string().trim().min(3).max(300),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

export class AccountingPeriodError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export class AccountingPeriodClosedError extends AccountingPeriodError {
  constructor(readonly periodKey: string) {
    super(`Accounting period ${periodKey} is closed. Reopen it from Month-end close before posting this transaction.`);
  }
}

export function periodKeyFromDateKey(dateKey: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(dateKey)) throw new AccountingPeriodError("Use a valid business date.", 422);
  return dateKey.slice(0, 7);
}

export function shiftAccountingPeriod(periodKey: string, months: number) {
  const parsed = accountingPeriodKeySchema.parse(periodKey);
  const [year, month] = parsed.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function accountingPeriodBounds(periodKey: string) {
  const parsed = accountingPeriodKeySchema.parse(periodKey);
  const [year, month] = parsed.split("-").map(Number);
  const finalDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startKey: `${parsed}-01`,
    endKey: `${parsed}-${String(finalDay).padStart(2, "0")}`,
    start: new Date(`${parsed}-01T00:00:00.000Z`),
    end: new Date(`${parsed}-${String(finalDay).padStart(2, "0")}T23:59:59.999Z`),
  };
}

export function assertCompletedAccountingPeriod(periodKey: string, currentPeriodKey: string) {
  accountingPeriodKeySchema.parse(periodKey);
  accountingPeriodKeySchema.parse(currentPeriodKey);
  if (periodKey >= currentPeriodKey) throw new AccountingPeriodError("Only a completed calendar month can be closed.", 422);
}

export function assertAccountingPeriodVersion(updatedAt: unknown, expectedUpdatedAt?: string) {
  if (!updatedAt && !expectedUpdatedAt) return;
  const current = updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
  const expected = expectedUpdatedAt ? new Date(expectedUpdatedAt).getTime() : Number.NaN;
  if (!Number.isFinite(current) || !Number.isFinite(expected) || current !== expected) {
    throw new AccountingPeriodError("This accounting period changed in another session. Refresh before trying again.");
  }
}

export function nextAccountingPeriodUpdatedAt(previous: unknown, now = new Date()) {
  const old = previous instanceof Date ? previous.getTime() : new Date(String(previous)).getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(old) ? old + 1 : 0));
}

export type PeriodChecklistInput = {
  journalCount: number;
  totalDebit: number;
  totalCredit: number;
  unbalancedCount: number;
  requiredBankAccounts: Array<{ code: string; name: string }>;
  reconciledBankCodes: string[];
  openBankReconciliationCount: number;
  fixedAssetDueCount?: number;
};

export function buildPeriodChecklist(input: PeriodChecklistInput, currency: string) {
  const reconciled = new Set(input.reconciledBankCodes);
  const missingBankAccounts = input.requiredBankAccounts.filter(account => !reconciled.has(account.code));
  const blockers: string[] = [];
  if (input.unbalancedCount) blockers.push(`${input.unbalancedCount} posted journal entr${input.unbalancedCount === 1 ? "y is" : "ies are"} unbalanced.`);
  if (currencyMinorUnits(input.totalDebit, currency) !== currencyMinorUnits(input.totalCredit, currency)) blockers.push("The period debit and credit totals do not agree.");
  if (input.openBankReconciliationCount) blockers.push(`${input.openBankReconciliationCount} overlapping bank reconciliation draft${input.openBankReconciliationCount === 1 ? " is" : "s are"} still open.`);
  if (missingBankAccounts.length) blockers.push(`Complete bank reconciliation for ${missingBankAccounts.map(account => `${account.code} · ${account.name}`).join(", ")}.`);
  if (input.fixedAssetDueCount) blockers.push(`Post depreciation through this month for ${input.fixedAssetDueCount} fixed asset${input.fixedAssetDueCount === 1 ? "" : "s"}.`);
  return {
    journalCount: input.journalCount,
    totalDebit: roundCurrency(input.totalDebit, currency),
    totalCredit: roundCurrency(input.totalCredit, currency),
    unbalancedCount: input.unbalancedCount,
    requiredBankAccountCount: input.requiredBankAccounts.length,
    reconciledBankAccountCount: input.requiredBankAccounts.length - missingBankAccounts.length,
    missingBankAccounts,
    openBankReconciliationCount: input.openBankReconciliationCount,
    fixedAssetDueCount: input.fixedAssetDueCount || 0,
    blockers,
    ready: blockers.length === 0,
  };
}

export function accountingPeriodSnapshotChanged(snapshot: { journalCount?: unknown; totalDebit?: unknown; totalCredit?: unknown; fixedAssetDueCount?: unknown } | null | undefined, live: { journalCount: number; totalDebit: number; totalCredit: number; fixedAssetDueCount?: number }, currency: string) {
  if (!snapshot) return true;
  return Number(snapshot.journalCount || 0) !== live.journalCount
    || currencyMinorUnits(Number(snapshot.totalDebit || 0), currency) !== currencyMinorUnits(live.totalDebit, currency)
    || currencyMinorUnits(Number(snapshot.totalCredit || 0), currency) !== currencyMinorUnits(live.totalCredit, currency)
    || Number(snapshot.fixedAssetDueCount || 0) !== Number(live.fixedAssetDueCount || 0);
}
