"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Boxes, CalendarRange, CheckCircle2, CircleDollarSign, Download,
  Landmark, Printer, ReceiptText, Scale, TrendingUp, WalletCards,
} from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, Notice, PageHeader, StatCard, useNotice } from "@/components/ui";
import { useBusiness } from "@/components/business-context";
import { dateKeyInTimeZone } from "@/lib/dates";

type FinancialRow = { code: string; name: string; amount: number };
type TrialRow = FinancialRow & {
  type: string;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
};
type AgingRow = { id: string; documentNo: string; party: string; dueDate: string; balance: number; daysPastDue: number; bucket: string; status?: string };
type AgingReport = {
  asOf: string;
  total: number;
  count: number;
  buckets: Array<{ key: string; label: string; amount: number; count: number }>;
  rows: AgingRow[];
};
type ReportData = {
  period: { from: string; to: string; days: number; timeZone: string; currency: string; trendInterval: "DAY" | "MONTH" };
  profitAndLoss: {
    revenue: FinancialRow[]; expenses: FinancialRow[]; salesRevenue: number; otherIncome: number; totalRevenue: number;
    costOfGoodsSold: number; grossProfit: number; operatingExpenses: number; operatingProfit: number; otherExpenses: number;
    totalExpenses: number; netProfit: number; margin: number;
  };
  balanceSheet: { assets: FinancialRow[]; liabilities: FinancialRow[]; equity: FinancialRow[]; totalAssets: number; totalLiabilities: number; totalEquity: number; equationDifference: number };
  cashFlow: {
    operating: FinancialRow[]; investing: FinancialRow[]; financing: FinancialRow[]; unclassified: FinancialRow[];
    openingCash: number; operatingCash: number; investingCash: number; financingCash: number; unclassifiedCash: number;
    netCashMovement: number; closingCash: number; reconciliationDifference: number;
  };
  trialBalance: {
    rows: TrialRow[];
    totals: { openingDebit: number; openingCredit: number; periodDebit: number; periodCredit: number; closingDebit: number; closingCredit: number };
    periodDifference: number; closingDifference: number;
  };
  tax: { outputTaxCharged: number; outputTaxAdjustments: number; inputTaxRecoverable: number; inputTaxAdjustments: number; netMovement: number };
  integrity: { balanced: boolean; equationDifference: number; periodDifference: number; closingDifference: number; journalCount: number; unbalancedEntries: number };
  operations: {
    summary: { revenue: number; cost: number; grossProfit: number; margin: number; transactions: number; items: number };
    trend: Array<{ _id: string; revenue: number; cost: number }>;
    payments: Array<{ _id: string; value: number; count: number }>;
    inventoryValue: { retail: number; cost: number; units: number };
    draftInvoiceCount: number;
  };
  aging: { receivables: AgingReport; payables: AgingReport };
};

type ReportTab = "OVERVIEW" | "PROFIT_LOSS" | "BALANCE_SHEET" | "CASH_FLOW" | "TRIAL_BALANCE" | "AGING";
const REPORT_TABS: Array<{ key: ReportTab; label: string }> = [
  { key: "OVERVIEW", label: "Overview" },
  { key: "PROFIT_LOSS", label: "Profit & loss" },
  { key: "BALANCE_SHEET", label: "Balance sheet" },
  { key: "CASH_FLOW", label: "Cash flow" },
  { key: "TRIAL_BALANCE", label: "Trial balance" },
  { key: "AGING", label: "AR / AP aging" },
];

function StatementLines({ rows, money, empty = "No posted movement in this section." }: { rows: FinancialRow[]; money: Intl.NumberFormat; empty?: string }) {
  return rows.some((row) => row.amount !== 0) ? <div className="statement-lines">{rows.filter((row) => row.amount !== 0).map((row) => <div key={row.code}><span><b>{row.code}</b>{row.name}</span><strong className={row.amount < 0 ? "negative" : ""}>{money.format(row.amount)}</strong></div>)}</div> : <p className="statement-empty">{empty}</p>;
}

function StatementTotal({ label, value, money, grand = false }: { label: string; value: number; money: Intl.NumberFormat; grand?: boolean }) {
  return <div className={`statement-total${grand ? " grand" : ""}`}><span>{label}</span><strong className={value < 0 ? "negative" : ""}>{money.format(value)}</strong></div>;
}

function AgingPanel({ title, report, money }: { title: string; report: AgingReport; money: Intl.NumberFormat }) {
  return <article className="panel aging-panel"><header className="panel-header"><div><span className="eyebrow">AS AT {report.asOf}</span><h2>{title}</h2></div><strong>{money.format(report.total)}</strong></header>
    <div className="aging-buckets">{report.buckets.map((bucket) => <div key={bucket.key}><span>{bucket.label}</span><strong>{money.format(bucket.amount)}</strong><small>{bucket.count} document{bucket.count === 1 ? "" : "s"}</small></div>)}</div>
    {report.rows.length ? <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Document</th><th>Customer / supplier</th><th>Due date</th><th>Days overdue</th><th className="number">Balance</th></tr></thead><tbody>{report.rows.map((row) => <tr key={row.id}><td><b>{row.documentNo}</b></td><td>{row.party}</td><td>{row.dueDate}</td><td>{row.daysPastDue || "Current"}</td><td className="number">{money.format(row.balance)}</td></tr>)}</tbody></table></div> : <EmptyState title="Nothing outstanding" detail="Open documents will be aged automatically by due date." />}
  </article>;
}

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function ReportsView() {
  const { profile } = useBusiness();
  const today = useMemo(() => dateKeyInTimeZone(new Date(), profile.timeZone), [profile.timeZone]);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<ReportTab>("OVERVIEW");
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const { notice, show } = useNotice();
  const money = useMemo(() => new Intl.NumberFormat(profile.locale, { style: "currency", currency: data?.period.currency || profile.currency }), [data?.period.currency, profile.currency, profile.locale]);

  const load = useCallback(async () => {
    if (!from || !to || from > to) return;
    setLoading(true);
    try { setData(await apiRequest<ReportData>(`/api/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not build the financial reports.", "error"); }
    finally { setLoading(false); }
  }, [from, show, to]);

  useEffect(() => { void load(); }, [load]);

  function applyPreset(preset: "MONTH" | "QUARTER" | "YEAR") {
    const [year, month] = today.split("-").map(Number);
    const startMonth = preset === "MONTH" ? month : preset === "QUARTER" ? Math.floor((month - 1) / 3) * 3 + 1 : 1;
    setFrom(`${year}-${String(startMonth).padStart(2, "0")}-01`);
    setTo(today);
  }

  function exportCsv() {
    if (!data) return;
    const rows: Array<Array<string | number>> = [["Report", REPORT_TABS.find((item) => item.key === tab)?.label || tab], ["Period", `${data.period.from} to ${data.period.to}`], ["Currency", data.period.currency], []];
    if (tab === "PROFIT_LOSS") {
      rows.push(["Section", "Code", "Account", "Amount"], ...data.profitAndLoss.revenue.map((row) => ["Revenue", row.code, row.name, row.amount]), ...data.profitAndLoss.expenses.map((row) => ["Expense", row.code, row.name, row.amount]), ["Net profit", "", "", data.profitAndLoss.netProfit]);
    } else if (tab === "BALANCE_SHEET") {
      rows.push(["Section", "Code", "Account", "Amount"], ...data.balanceSheet.assets.map((row) => ["Asset", row.code, row.name, row.amount]), ...data.balanceSheet.liabilities.map((row) => ["Liability", row.code, row.name, row.amount]), ...data.balanceSheet.equity.map((row) => ["Equity", row.code, row.name, row.amount]));
    } else if (tab === "CASH_FLOW") {
      rows.push(["Section", "Source", "Description", "Amount"], ...data.cashFlow.operating.map((row) => ["Operating", row.code, row.name, row.amount]), ...data.cashFlow.investing.map((row) => ["Investing", row.code, row.name, row.amount]), ...data.cashFlow.financing.map((row) => ["Financing", row.code, row.name, row.amount]), ...data.cashFlow.unclassified.map((row) => ["Unclassified", row.code, row.name, row.amount]), ["Closing cash", "", "", data.cashFlow.closingCash]);
    } else if (tab === "TRIAL_BALANCE") {
      rows.push(["Code", "Account", "Type", "Opening debit", "Opening credit", "Period debit", "Period credit", "Closing debit", "Closing credit"], ...data.trialBalance.rows.map((row) => [row.code, row.name, row.type, row.openingDebit, row.openingCredit, row.periodDebit, row.periodCredit, row.closingDebit, row.closingCredit]));
    } else if (tab === "AGING") {
      rows.push(["Ledger", "Document", "Party", "Due date", "Days overdue", "Balance"], ...data.aging.receivables.rows.map((row) => ["Receivable", row.documentNo, row.party, row.dueDate, row.daysPastDue, row.balance]), ...data.aging.payables.rows.map((row) => ["Payable", row.documentNo, row.party, row.dueDate, row.daysPastDue, row.balance]));
    } else {
      rows.push(["Metric", "Value"], ["Net profit", data.profitAndLoss.netProfit], ["Total assets", data.balanceSheet.totalAssets], ["Closing cash", data.cashFlow.closingCash], ["Receivables", data.aging.receivables.total], ["Payables", data.aging.payables.total], ["Inventory at cost", data.operations.inventoryValue.cost]);
    }
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `financial-report-${tab.toLowerCase()}-${data.period.from}-${data.period.to}.csv`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  const maxTrend = useMemo(() => Math.max(...(data?.operations.trend.flatMap((point) => [Math.abs(point.revenue), Math.abs(point.cost)]) || [1]), 1), [data]);

  return <div className="page page-enter financial-reports-page">
    <PageHeader eyebrow="FINANCIAL CONTROL" title="Financial reports" description="Posted-ledger statements, operational aging and a visible close check for every reporting period." action={<div className="report-actions"><button className="button button-secondary" onClick={exportCsv} disabled={!data}><Download />Export CSV</button><button className="button button-secondary" onClick={() => window.print()} disabled={!data}><Printer />Print</button></div>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="report-period-control"><CalendarRange /><label><span>From</span><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label><label><span>To</span><input type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)} /></label><div><button onClick={() => applyPreset("MONTH")}>This month</button><button onClick={() => applyPreset("QUARTER")}>This quarter</button><button onClick={() => applyPreset("YEAR")}>This year</button></div>{data ? <small>{data.period.currency} · {data.period.timeZone} · {data.period.days} days</small> : null}</section>
    {loading || !data ? <LoadingPanel label="Closing the ledger and building statements…" /> : <>
      <section className={`report-close-ribbon ${data.integrity.balanced ? "balanced" : "attention"}`}>
        <div className="close-mark">{data.integrity.balanced ? <CheckCircle2 /> : <AlertTriangle />}</div>
        <div><span>ASSETS</span><strong>{money.format(data.balanceSheet.totalAssets)}</strong></div><b>=</b><div><span>LIABILITIES</span><strong>{money.format(data.balanceSheet.totalLiabilities)}</strong></div><b>+</b><div><span>EQUITY + EARNINGS</span><strong>{money.format(data.balanceSheet.totalEquity)}</strong></div>
        <p><strong>{data.integrity.balanced ? "Ledger balanced" : "Close requires attention"}</strong><span>{data.integrity.journalCount} posted journals in period · {data.integrity.unbalancedEntries} unbalanced entries · equation variance {money.format(data.integrity.equationDifference)}</span></p>
      </section>
      <nav className="report-tabs" aria-label="Financial report"><div role="tablist">{REPORT_TABS.map((item) => <button key={item.key} role="tab" aria-selected={tab === item.key} className={tab === item.key ? "active" : ""} onClick={() => setTab(item.key)}>{item.label}</button>)}</div></nav>

      {tab === "OVERVIEW" ? <div className="report-tab-panel">
        <section className="stat-grid"><StatCard label="Net profit" value={money.format(data.profitAndLoss.netProfit)} detail={`${data.profitAndLoss.margin.toFixed(1)}% net margin`} icon={<CircleDollarSign />} /><StatCard label="Gross profit" value={money.format(data.profitAndLoss.grossProfit)} detail={`${data.operations.summary.transactions} completed sales`} tone="sand" icon={<TrendingUp />} /><StatCard label="Stock at cost" value={money.format(data.operations.inventoryValue.cost)} detail={`${data.operations.inventoryValue.units} units on hand`} tone="ink" icon={<Boxes />} /><StatCard label="Working capital due" value={money.format(data.aging.receivables.total - data.aging.payables.total)} detail={`${data.aging.receivables.count} AR · ${data.aging.payables.count} AP`} tone="plum" icon={<Landmark />} /></section>
        <section className="reports-grid"><article className="panel report-trend"><header className="panel-header"><div><span className="eyebrow">OPERATING PERFORMANCE</span><h2>Sales revenue & cost</h2></div><span className="panel-note">{data.period.from} — {data.period.to}</span></header>{data.operations.trend.length ? <div className="bar-chart">{data.operations.trend.map((point) => <div className="bar-column" key={point._id} title={`${point._id}: ${money.format(point.revenue)}`}><div className="bar-pair"><i style={{ height: `${(Math.abs(point.cost) / maxTrend) * 100}%` }} /><b style={{ height: `${(Math.abs(point.revenue) / maxTrend) * 100}%` }} /></div><span>{point._id}</span></div>)}</div> : <EmptyState title="No sales in this period" detail="Choose another period or post sales through POS." />}</article>
        <article className="panel"><header className="panel-header"><div><span className="eyebrow">TENDER MIX</span><h2>Payments received</h2></div><ReceiptText /></header>{data.operations.payments.length ? <div className="payment-report">{data.operations.payments.map((payment) => <div key={payment._id}><span>{payment._id}</span><div><i style={{ width: `${Math.max(4, data.operations.summary.revenue ? (payment.value / data.operations.summary.revenue) * 100 : 4)}%` }} /></div><strong>{money.format(payment.value)}</strong><small>{payment.count} sales</small></div>)}</div> : <EmptyState title="No payment data" detail="Completed POS transactions will be grouped here." />}</article></section>
        <section className="report-summary-strip"><div><span>Output tax charged</span><strong>{money.format(data.tax.outputTaxCharged)}</strong></div><div><span>Input tax recoverable</span><strong>{money.format(data.tax.inputTaxRecoverable)}</strong></div><div><span>Net tax movement</span><strong>{money.format(data.tax.netMovement)}</strong></div><div><span>Draft invoices excluded from AR</span><strong>{data.operations.draftInvoiceCount}</strong></div></section>
      </div> : null}

      {tab === "PROFIT_LOSS" ? <section className="statement-sheet report-tab-panel"><header><span>PROFIT & LOSS</span><h2>For {data.period.from} to {data.period.to}</h2><small>Accrual movements from posted journal entries · {data.period.currency}</small></header><div className="statement-section"><h3>Revenue</h3><StatementLines rows={data.profitAndLoss.revenue} money={money} /><StatementTotal label="Total revenue" value={data.profitAndLoss.totalRevenue} money={money} /></div><div className="statement-section"><h3>Cost of sales</h3><StatementLines rows={data.profitAndLoss.expenses.filter((row) => row.code === "5000")} money={money} /><StatementTotal label="Gross profit" value={data.profitAndLoss.grossProfit} money={money} /></div><div className="statement-section"><h3>Operating and other expenses</h3><StatementLines rows={data.profitAndLoss.expenses.filter((row) => row.code !== "5000")} money={money} /><StatementTotal label="Total expenses" value={data.profitAndLoss.totalExpenses} money={money} /><StatementTotal label="Net profit / (loss)" value={data.profitAndLoss.netProfit} money={money} grand /></div></section> : null}

      {tab === "BALANCE_SHEET" ? <section className="statement-sheet report-tab-panel"><header><span>BALANCE SHEET</span><h2>As at {data.period.to}</h2><small>Posted balances including cumulative earnings · {data.period.currency}</small></header><div className="statement-columns"><div className="statement-section"><h3>Assets</h3><StatementLines rows={data.balanceSheet.assets} money={money} /><StatementTotal label="Total assets" value={data.balanceSheet.totalAssets} money={money} grand /></div><div><div className="statement-section"><h3>Liabilities</h3><StatementLines rows={data.balanceSheet.liabilities} money={money} /><StatementTotal label="Total liabilities" value={data.balanceSheet.totalLiabilities} money={money} /></div><div className="statement-section"><h3>Equity</h3><StatementLines rows={data.balanceSheet.equity} money={money} /><StatementTotal label="Total equity + earnings" value={data.balanceSheet.totalEquity} money={money} grand /></div></div></div></section> : null}

      {tab === "CASH_FLOW" ? <section className="statement-sheet report-tab-panel"><header><span>CASH FLOW</span><h2>For {data.period.from} to {data.period.to}</h2><small>Direct cash-equivalent movements from posted journals · {data.period.currency}</small></header><StatementTotal label="Opening cash and bank" value={data.cashFlow.openingCash} money={money} /><div className="statement-section"><h3>Operating activities</h3><StatementLines rows={data.cashFlow.operating} money={money} /><StatementTotal label="Net operating cash" value={data.cashFlow.operatingCash} money={money} /></div><div className="statement-columns"><div className="statement-section"><h3>Investing activities</h3><StatementLines rows={data.cashFlow.investing} money={money} /><StatementTotal label="Net investing cash" value={data.cashFlow.investingCash} money={money} /></div><div className="statement-section"><h3>Financing activities</h3><StatementLines rows={data.cashFlow.financing} money={money} /><StatementTotal label="Net financing cash" value={data.cashFlow.financingCash} money={money} /></div></div>{data.cashFlow.unclassified.some((row) => row.amount !== 0) ? <div className="statement-section attention-section"><h3>Manual journals requiring classification</h3><StatementLines rows={data.cashFlow.unclassified} money={money} /><StatementTotal label="Unclassified cash" value={data.cashFlow.unclassifiedCash} money={money} /></div> : null}<StatementTotal label="Net change in cash" value={data.cashFlow.netCashMovement} money={money} /><StatementTotal label="Closing cash and bank" value={data.cashFlow.closingCash} money={money} grand /></section> : null}

      {tab === "TRIAL_BALANCE" ? <section className="panel report-tab-panel trial-panel"><header className="panel-header"><div><span className="eyebrow">CONTROL REPORT</span><h2>Trial balance</h2></div><Scale /></header><div className="report-table-wrap"><table className="report-table trial-table"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="number">Opening Dr</th><th className="number">Opening Cr</th><th className="number">Period Dr</th><th className="number">Period Cr</th><th className="number">Closing Dr</th><th className="number">Closing Cr</th></tr></thead><tbody>{data.trialBalance.rows.map((row) => <tr key={row.code}><td><b>{row.code}</b></td><td>{row.name}</td><td>{row.type}</td><td className="number">{row.openingDebit ? money.format(row.openingDebit) : "—"}</td><td className="number">{row.openingCredit ? money.format(row.openingCredit) : "—"}</td><td className="number">{row.periodDebit ? money.format(row.periodDebit) : "—"}</td><td className="number">{row.periodCredit ? money.format(row.periodCredit) : "—"}</td><td className="number">{row.closingDebit ? money.format(row.closingDebit) : "—"}</td><td className="number">{row.closingCredit ? money.format(row.closingCredit) : "—"}</td></tr>)}</tbody><tfoot><tr><th colSpan={3}>Totals</th><th className="number">{money.format(data.trialBalance.totals.openingDebit)}</th><th className="number">{money.format(data.trialBalance.totals.openingCredit)}</th><th className="number">{money.format(data.trialBalance.totals.periodDebit)}</th><th className="number">{money.format(data.trialBalance.totals.periodCredit)}</th><th className="number">{money.format(data.trialBalance.totals.closingDebit)}</th><th className="number">{money.format(data.trialBalance.totals.closingCredit)}</th></tr></tfoot></table></div></section> : null}

      {tab === "AGING" ? <div className="aging-report-grid report-tab-panel"><AgingPanel title="Accounts receivable aging" report={data.aging.receivables} money={money} /><AgingPanel title="Accounts payable aging" report={data.aging.payables} money={money} /><div className="aging-note"><WalletCards /><p><strong>Operational aging is separate from the posted ledger.</strong><span>Receivables include sent, unpaid customer invoices. Draft invoices are excluded. Payables use supplier bills at base-currency carrying value.</span></p></div></div> : null}
    </>}
  </div>;
}
