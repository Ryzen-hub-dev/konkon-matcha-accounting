import { currencyMinorUnits, roundCurrency } from "@/lib/international";

export type JournalAmountLine = { accountCode: string; accountName: string; debit: number; credit: number };

export function prepareJournalAmounts(input: JournalAmountLine[], currency: string) {
  const lines = input.map(line => {
    const debit = roundCurrency(line.debit, currency);
    const credit = roundCurrency(line.credit, currency);
    if (!Number.isFinite(line.debit) || !Number.isFinite(line.credit) || debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) throw new Error("Each line needs a positive debit or credit, not both.");
    if (Math.abs(debit - line.debit) > 1e-8 || Math.abs(credit - line.credit) > 1e-8) throw new Error(`Use the supported decimal precision for ${currency}.`);
    return { ...line, debit, credit };
  });
  const debitUnits = lines.reduce((sum, line) => sum + currencyMinorUnits(line.debit, currency), 0);
  const creditUnits = lines.reduce((sum, line) => sum + currencyMinorUnits(line.credit, currency), 0);
  if (!debitUnits || debitUnits !== creditUnits) throw new Error("Debits and credits must balance exactly.");
  return {
    lines,
    totalDebit: roundCurrency(lines.reduce((sum, line) => sum + line.debit, 0), currency),
    totalCredit: roundCurrency(lines.reduce((sum, line) => sum + line.credit, 0), currency),
  };
}
