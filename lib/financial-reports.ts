import { roundCurrency } from "@/lib/international";

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type FinancialAccount = {
  code: string;
  name: string;
  type: AccountType;
  cashEquivalent?: boolean;
};

export type AccountMovement = {
  code: string;
  name?: string;
  openingDebit?: number;
  openingCredit?: number;
  periodDebit?: number;
  periodCredit?: number;
};

export type CashSourceMovement = {
  source: string;
  openingAmount?: number;
  periodAmount?: number;
};

export type FinancialRow = {
  code: string;
  name: string;
  amount: number;
};

export type TrialBalanceRow = FinancialRow & {
  type: AccountType;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
};

export type AgingDocument = {
  id: string;
  documentNo: string;
  party: string;
  dueDate: string | Date;
  balance: number;
  status?: string;
};

export type AgingBucketKey = "CURRENT" | "1_30" | "31_60" | "61_90" | "OVER_90";

const BUCKETS: Array<{ key: AgingBucketKey; label: string }> = [
  { key: "CURRENT", label: "Current" },
  { key: "1_30", label: "1–30 days" },
  { key: "31_60", label: "31–60 days" },
  { key: "61_90", label: "61–90 days" },
  { key: "OVER_90", label: "Over 90 days" },
];

function inferredAccountType(code: string): AccountType {
  if (code.startsWith("1")) return "ASSET";
  if (code.startsWith("2")) return "LIABILITY";
  if (code.startsWith("3")) return "EQUITY";
  if (code.startsWith("4")) return "REVENUE";
  return "EXPENSE";
}

function amount(value: unknown, currency: string) {
  return roundCurrency(Number(value || 0), currency);
}

function normalBalance(type: AccountType, debit: number, credit: number, currency: string) {
  return amount(type === "ASSET" || type === "EXPENSE" ? debit - credit : credit - debit, currency);
}

function splitBalance(value: number, normalSide: "DEBIT" | "CREDIT", currency: string) {
  const rounded = amount(value, currency);
  if (normalSide === "DEBIT") return rounded >= 0 ? { debit: rounded, credit: 0 } : { debit: 0, credit: amount(-rounded, currency) };
  return rounded >= 0 ? { debit: 0, credit: rounded } : { debit: amount(-rounded, currency), credit: 0 };
}

function total(rows: FinancialRow[], currency: string) {
  return amount(rows.reduce((sum, row) => sum + row.amount, 0), currency);
}

function cashSection(source: string) {
  if (["CAPITAL", "EQUITY", "LOAN", "FINANCING"].includes(source)) return "FINANCING" as const;
  if (["FIXED_ASSET", "ASSET_DISPOSAL", "INVESTING"].includes(source)) return "INVESTING" as const;
  if (source === "MANUAL") return "UNCLASSIFIED" as const;
  return "OPERATING" as const;
}

function cashSourceLabel(source: string) {
  const labels: Record<string, string> = {
    POS: "Point-of-sale receipts",
    POS_REFUND: "Point-of-sale refunds",
    INVOICE: "Invoice receipts",
    SUPPLIER_PAYMENT: "Supplier payments",
    CAPITAL: "Capital introduced or withdrawn",
    EQUITY: "Equity movements",
    LOAN: "Borrowings and repayments",
    FIXED_ASSET: "Fixed asset movements",
    ASSET_DISPOSAL: "Asset disposal proceeds",
    MANUAL: "Manual journals awaiting classification",
  };
  return labels[source] || source.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function assembleFinancialStatements({
  accounts,
  movements,
  cashMovements,
  currency,
}: {
  accounts: FinancialAccount[];
  movements: AccountMovement[];
  cashMovements: CashSourceMovement[];
  currency: string;
}) {
  const accountMap = new Map(accounts.map((account) => [account.code, account]));
  const movementMap = new Map(movements.map((movement) => [movement.code, movement]));
  const codes = [...new Set([...accountMap.keys(), ...movementMap.keys()])].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

  const trialBalance: TrialBalanceRow[] = codes.map((code) => {
    const movement = movementMap.get(code);
    const account = accountMap.get(code) || { code, name: movement?.name || `Account ${code}`, type: inferredAccountType(code) };
    const openingDebitMovement = amount(movement?.openingDebit, currency);
    const openingCreditMovement = amount(movement?.openingCredit, currency);
    const periodDebit = amount(movement?.periodDebit, currency);
    const periodCredit = amount(movement?.periodCredit, currency);
    const normalSide = account.type === "ASSET" || account.type === "EXPENSE" ? "DEBIT" : "CREDIT";
    const opening = splitBalance(normalBalance(account.type, openingDebitMovement, openingCreditMovement, currency), normalSide, currency);
    const closing = splitBalance(normalBalance(account.type, openingDebitMovement + periodDebit, openingCreditMovement + periodCredit, currency), normalSide, currency);
    return {
      code,
      name: account.name,
      type: account.type,
      amount: amount(closing.debit - closing.credit, currency),
      openingDebit: opening.debit,
      openingCredit: opening.credit,
      periodDebit,
      periodCredit,
      closingDebit: closing.debit,
      closingCredit: closing.credit,
    };
  });

  const movementFor = (row: TrialBalanceRow) => amount(row.periodCredit - row.periodDebit, currency);
  const revenue = trialBalance.filter((row) => row.type === "REVENUE").map((row) => ({ code: row.code, name: row.name, amount: movementFor(row) }));
  const expenses = trialBalance.filter((row) => row.type === "EXPENSE").map((row) => ({ code: row.code, name: row.name, amount: amount(row.periodDebit - row.periodCredit, currency) }));
  const salesRevenue = total(revenue.filter((row) => row.code === "4000"), currency);
  const otherIncome = total(revenue.filter((row) => row.code !== "4000"), currency);
  const costOfGoodsSold = total(expenses.filter((row) => row.code === "5000"), currency);
  const operatingExpenses = total(expenses.filter((row) => row.code !== "5000" && row.code !== "6200"), currency);
  const otherExpenses = total(expenses.filter((row) => row.code === "6200"), currency);
  const totalRevenue = total(revenue, currency);
  const totalExpenses = total(expenses, currency);
  const grossProfit = amount(salesRevenue - costOfGoodsSold, currency);
  const operatingProfit = amount(grossProfit - operatingExpenses, currency);
  const netProfit = amount(totalRevenue - totalExpenses, currency);

  const closingBalance = (row: TrialBalanceRow) => amount(row.closingDebit - row.closingCredit, currency);
  const assets = trialBalance.filter((row) => row.type === "ASSET").map((row) => ({ code: row.code, name: row.name, amount: closingBalance(row) }));
  const liabilities = trialBalance.filter((row) => row.type === "LIABILITY").map((row) => ({ code: row.code, name: row.name, amount: amount(row.closingCredit - row.closingDebit, currency) }));
  const postedEquity = trialBalance.filter((row) => row.type === "EQUITY").map((row) => ({ code: row.code, name: row.name, amount: amount(row.closingCredit - row.closingDebit, currency) }));
  const cumulativeEarnings = amount(
    trialBalance.filter((row) => row.type === "REVENUE").reduce((sum, row) => sum + row.closingCredit - row.closingDebit, 0)
      - trialBalance.filter((row) => row.type === "EXPENSE").reduce((sum, row) => sum + row.closingDebit - row.closingCredit, 0),
    currency,
  );
  const equity = [...postedEquity, { code: "CURRENT_EARNINGS", name: "Cumulative earnings", amount: cumulativeEarnings }];
  const totalAssets = total(assets, currency);
  const totalLiabilities = total(liabilities, currency);
  const totalEquity = total(equity, currency);
  const equationDifference = amount(totalAssets - totalLiabilities - totalEquity, currency);

  const openingCash = amount(cashMovements.reduce((sum, row) => sum + Number(row.openingAmount || 0), 0), currency);
  const cashSections = {
    operating: [] as FinancialRow[],
    investing: [] as FinancialRow[],
    financing: [] as FinancialRow[],
    unclassified: [] as FinancialRow[],
  };
  for (const movement of cashMovements) {
    const row = { code: movement.source || "OTHER", name: cashSourceLabel(movement.source || "OTHER"), amount: amount(movement.periodAmount, currency) };
    const section = cashSection(movement.source || "OTHER");
    if (section === "FINANCING") cashSections.financing.push(row);
    else if (section === "INVESTING") cashSections.investing.push(row);
    else if (section === "UNCLASSIFIED") cashSections.unclassified.push(row);
    else cashSections.operating.push(row);
  }
  const operatingCash = total(cashSections.operating, currency);
  const investingCash = total(cashSections.investing, currency);
  const financingCash = total(cashSections.financing, currency);
  const unclassifiedCash = total(cashSections.unclassified, currency);
  const netCashMovement = amount(operatingCash + investingCash + financingCash + unclassifiedCash, currency);
  const closingCash = amount(openingCash + netCashMovement, currency);

  const trialTotals = {
    openingDebit: amount(trialBalance.reduce((sum, row) => sum + row.openingDebit, 0), currency),
    openingCredit: amount(trialBalance.reduce((sum, row) => sum + row.openingCredit, 0), currency),
    periodDebit: amount(trialBalance.reduce((sum, row) => sum + row.periodDebit, 0), currency),
    periodCredit: amount(trialBalance.reduce((sum, row) => sum + row.periodCredit, 0), currency),
    closingDebit: amount(trialBalance.reduce((sum, row) => sum + row.closingDebit, 0), currency),
    closingCredit: amount(trialBalance.reduce((sum, row) => sum + row.closingCredit, 0), currency),
  };
  const periodDifference = amount(trialTotals.periodDebit - trialTotals.periodCredit, currency);
  const closingDifference = amount(trialTotals.closingDebit - trialTotals.closingCredit, currency);
  const outputTax = movementMap.get("2100");
  const inputTax = movementMap.get("1300");
  const outputTaxCharged = amount(outputTax?.periodCredit, currency);
  const outputTaxAdjustments = amount(outputTax?.periodDebit, currency);
  const inputTaxRecoverable = amount(inputTax?.periodDebit, currency);
  const inputTaxAdjustments = amount(inputTax?.periodCredit, currency);

  return {
    profitAndLoss: {
      revenue,
      expenses,
      salesRevenue,
      otherIncome,
      totalRevenue,
      costOfGoodsSold,
      grossProfit,
      operatingExpenses,
      operatingProfit,
      otherExpenses,
      totalExpenses,
      netProfit,
      margin: totalRevenue ? (netProfit / totalRevenue) * 100 : 0,
    },
    balanceSheet: { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, equationDifference },
    cashFlow: {
      ...cashSections,
      openingCash,
      operatingCash,
      investingCash,
      financingCash,
      unclassifiedCash,
      netCashMovement,
      closingCash,
      reconciliationDifference: 0,
    },
    trialBalance: { rows: trialBalance, totals: trialTotals, periodDifference, closingDifference },
    tax: {
      outputTaxCharged,
      outputTaxAdjustments,
      inputTaxRecoverable,
      inputTaxAdjustments,
      netMovement: amount(outputTaxCharged - outputTaxAdjustments - inputTaxRecoverable + inputTaxAdjustments, currency),
    },
    integrity: { balanced: equationDifference === 0 && periodDifference === 0 && closingDifference === 0, equationDifference, periodDifference, closingDifference },
  };
}

function utcDay(value: string | Date) {
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function buildAgingReport(documents: AgingDocument[], asOf: string, currency: string) {
  const buckets = Object.fromEntries(BUCKETS.map((bucket) => [bucket.key, { ...bucket, amount: 0, count: 0 }])) as Record<AgingBucketKey, { key: AgingBucketKey; label: string; amount: number; count: number }>;
  const asOfDay = utcDay(asOf);
  const rows = documents.filter((document) => Number(document.balance) > 0).map((document) => {
    const dueDate = document.dueDate instanceof Date ? document.dueDate.toISOString().slice(0, 10) : String(document.dueDate).slice(0, 10);
    const daysPastDue = Math.max(0, Math.floor((asOfDay - utcDay(dueDate)) / 86_400_000));
    const bucket: AgingBucketKey = daysPastDue === 0 ? "CURRENT" : daysPastDue <= 30 ? "1_30" : daysPastDue <= 60 ? "31_60" : daysPastDue <= 90 ? "61_90" : "OVER_90";
    const balance = amount(document.balance, currency);
    buckets[bucket].amount = amount(buckets[bucket].amount + balance, currency);
    buckets[bucket].count += 1;
    return { ...document, dueDate, balance, daysPastDue, bucket };
  }).sort((left, right) => right.daysPastDue - left.daysPastDue || left.dueDate.localeCompare(right.dueDate));
  return {
    asOf,
    buckets: BUCKETS.map(({ key }) => buckets[key]),
    total: amount(rows.reduce((sum, row) => sum + row.balance, 0), currency),
    count: rows.length,
    rows,
  };
}
