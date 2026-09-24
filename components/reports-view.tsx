"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Boxes,
  CalendarRange,
  CheckCircle2,
  CircleDollarSign,
  Download,
  Landmark,
  Printer,
  ReceiptText,
  Scale,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import {
  apiRequest,
  EmptyState,
  LoadingPanel,
  Modal,
  Notice,
  PageHeader,
  StatCard,
  useNotice,
} from "@/components/ui";
import { useBusiness } from "@/components/business-context";
import { dateKeyInTimeZone } from "@/lib/dates";
import { CountryReportPanel } from "./country-report-panel";
import { csvCell } from "@/lib/receipt-export";
import { REPORT_LAYOUTS, type ReportLayoutType } from "@/lib/report-templates";

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
type AgingRow = {
  id: string;
  documentNo: string;
  party: string;
  dueDate: string;
  balance: number;
  daysPastDue: number;
  bucket: string;
  status?: string;
};
type AgingReport = {
  asOf: string;
  total: number;
  count: number;
  buckets: Array<{ key: string; label: string; amount: number; count: number }>;
  rows: AgingRow[];
};
type ReportData = {
  period: {
    from: string;
    to: string;
    days: number;
    timeZone: string;
    currency: string;
    trendInterval: "DAY" | "MONTH";
  };
  profitAndLoss: {
    revenue: FinancialRow[];
    expenses: FinancialRow[];
    salesRevenue: number;
    otherIncome: number;
    totalRevenue: number;
    costOfGoodsSold: number;
    grossProfit: number;
    operatingExpenses: number;
    operatingProfit: number;
    otherExpenses: number;
    totalExpenses: number;
    netProfit: number;
    margin: number;
  };
  balanceSheet: {
    assets: FinancialRow[];
    liabilities: FinancialRow[];
    equity: FinancialRow[];
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    equationDifference: number;
  };
  cashFlow: {
    operating: FinancialRow[];
    investing: FinancialRow[];
    financing: FinancialRow[];
    unclassified: FinancialRow[];
    openingCash: number;
    operatingCash: number;
    investingCash: number;
    financingCash: number;
    unclassifiedCash: number;
    netCashMovement: number;
    closingCash: number;
    reconciliationDifference: number;
  };
  trialBalance: {
    rows: TrialRow[];
    totals: {
      openingDebit: number;
      openingCredit: number;
      periodDebit: number;
      periodCredit: number;
      closingDebit: number;
      closingCredit: number;
    };
    periodDifference: number;
    closingDifference: number;
  };
  tax: {
    outputTaxCharged: number;
    outputTaxAdjustments: number;
    inputTaxRecoverable: number;
    inputTaxAdjustments: number;
    netMovement: number;
  };
  integrity: {
    balanced: boolean;
    equationDifference: number;
    periodDifference: number;
    closingDifference: number;
    journalCount: number;
    unbalancedEntries: number;
  };
  operations: {
    summary: {
      revenue: number;
      cost: number;
      grossProfit: number;
      margin: number;
      transactions: number;
      items: number;
    };
    trend: Array<{ _id: string; revenue: number; cost: number }>;
    payments: Array<{ _id: string; value: number; count: number }>;
    inventoryValue: { retail: number; cost: number; units: number };
    draftInvoiceCount: number;
  };
  aging: { receivables: AgingReport; payables: AgingReport };
};

type ReportTab =
  | "OVERVIEW"
  | "PROFIT_LOSS"
  | "BALANCE_SHEET"
  | "CASH_FLOW"
  | "TRIAL_BALANCE"
  | "AGING"
  | "COUNTRY";
type ReportTemplate = {
  _id: string;
  name: string;
  reportType: ReportLayoutType;
  title: string;
  subtitle: string;
  orientation: "PORTRAIT" | "LANDSCAPE";
  accent: "MATCHA" | "INK" | "PLUM";
  showZeroRows: boolean;
  showAccountCodes: boolean;
  sections: string[];
  version: number;
};
const REPORT_TABS: Array<{ key: ReportTab; label: string }> = [
  { key: "OVERVIEW", label: "Overview" },
  { key: "PROFIT_LOSS", label: "Profit & loss" },
  { key: "BALANCE_SHEET", label: "Balance sheet" },
  { key: "CASH_FLOW", label: "Cash flow" },
  { key: "TRIAL_BALANCE", label: "Trial balance" },
  { key: "AGING", label: "AR / AP aging" },
  { key: "COUNTRY", label: "Country report desk" },
];

function StatementLines({
  rows,
  money,
  empty = "No posted movement in this section.",
  showZero = false,
  showCodes = true,
}: {
  rows: FinancialRow[];
  money: Intl.NumberFormat;
  empty?: string;
  showZero?: boolean;
  showCodes?: boolean;
}) {
  const visible = showZero ? rows : rows.filter((row) => row.amount !== 0);
  return visible.length ? (
    <div className="statement-lines">
      {visible.map((row) => (
        <div key={row.code}>
          <span>
            {showCodes ? <b>{row.code}</b> : null}
            {row.name}
          </span>
          <strong className={row.amount < 0 ? "negative" : ""}>
            {money.format(row.amount)}
          </strong>
        </div>
      ))}
    </div>
  ) : (
    <p className="statement-empty">{empty}</p>
  );
}

function StatementTotal({
  label,
  value,
  money,
  grand = false,
}: {
  label: string;
  value: number;
  money: Intl.NumberFormat;
  grand?: boolean;
}) {
  return (
    <div className={`statement-total${grand ? " grand" : ""}`}>
      <span>{label}</span>
      <strong className={value < 0 ? "negative" : ""}>
        {money.format(value)}
      </strong>
    </div>
  );
}

function AgingPanel({
  title,
  report,
  money,
}: {
  title: string;
  report: AgingReport;
  money: Intl.NumberFormat;
}) {
  return (
    <article className="panel aging-panel">
      <header className="panel-header">
        <div>
          <span className="eyebrow">AS AT {report.asOf}</span>
          <h2>{title}</h2>
        </div>
        <strong>{money.format(report.total)}</strong>
      </header>
      <div className="aging-buckets">
        {report.buckets.map((bucket) => (
          <div key={bucket.key}>
            <span>{bucket.label}</span>
            <strong>{money.format(bucket.amount)}</strong>
            <small>
              {bucket.count} document{bucket.count === 1 ? "" : "s"}
            </small>
          </div>
        ))}
      </div>
      {report.rows.length ? (
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Customer / supplier</th>
                <th>Due date</th>
                <th>Days overdue</th>
                <th className="number">Balance</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <b>{row.documentNo}</b>
                  </td>
                  <td>{row.party}</td>
                  <td>{row.dueDate}</td>
                  <td>{row.daysPastDue || "Current"}</td>
                  <td className="number">{money.format(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="Nothing outstanding"
          detail="Open documents will be aged automatically by due date."
        />
      )}
    </article>
  );
}

export function ReportsView() {
  const { profile } = useBusiness();
  const today = useMemo(
    () => dateKeyInTimeZone(new Date(), profile.timeZone),
    [profile.timeZone],
  );
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<ReportTab>("OVERVIEW");
  const [data, setData] = useState<ReportData | null>(null);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [canDesign, setCanDesign] = useState(false);
  const [activeTemplateId, setActiveTemplateId] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<
    ReportTemplate | null | undefined
  >(undefined);
  const [designerType, setDesignerType] =
    useState<ReportLayoutType>("PROFIT_LOSS");
  const [loading, setLoading] = useState(true);
  const loadSequence = useRef(0);
  const { notice, show } = useNotice();
  const money = useMemo(
    () =>
      new Intl.NumberFormat(profile.locale, {
        style: "currency",
        currency: data?.period.currency || profile.currency,
      }),
    [data?.period.currency, profile.currency, profile.locale],
  );

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!from || !to || from > to) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await apiRequest<ReportData>(
        `/api/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      if (sequence === loadSequence.current) setData(result);
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setData(null);
        show(
          reason instanceof Error
            ? reason.message
            : "Could not build the financial reports.",
          "error",
        );
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [from, show, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadTemplates = useCallback(async () => {
    try {
      const result = await apiRequest<{
        templates: ReportTemplate[];
        canDesign: boolean;
      }>("/api/report-templates");
      setTemplates(result.templates);
      setCanDesign(result.canDesign);
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not load report layouts.",
        "error",
      );
    }
  }, [show]);
  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const activeTemplate = templates.find(
    (template) =>
      template._id === activeTemplateId && template.reportType === tab,
  );
  const includesSection = (section: string) =>
    !activeTemplate || activeTemplate.sections.includes(section);
  const statementClass = `statement-sheet report-tab-panel${activeTemplate ? ` report-layout-${activeTemplate.orientation.toLowerCase()} report-accent-${activeTemplate.accent.toLowerCase()}` : ""}`;

  function openDesigner() {
    const type: ReportLayoutType = [
      "PROFIT_LOSS",
      "BALANCE_SHEET",
      "CASH_FLOW",
      "TRIAL_BALANCE",
      "AGING",
    ].includes(tab)
      ? (tab as ReportLayoutType)
      : "PROFIT_LOSS";
    const current =
      templates.find(
        (template) =>
          template._id === activeTemplateId && template.reportType === type,
      ) || null;
    setDesignerType(current?.reportType || type);
    setEditingTemplate(current);
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const saved = await apiRequest<ReportTemplate>("/api/report-templates", {
        method: "POST",
        body: JSON.stringify({
          action: "SAVE",
          ...(editingTemplate
            ? {
                id: editingTemplate._id,
                expectedVersion: editingTemplate.version,
              }
            : {}),
          name: form.get("name"),
          reportType: designerType,
          title: form.get("title"),
          subtitle: form.get("subtitle"),
          orientation: form.get("orientation"),
          accent: form.get("accent"),
          showZeroRows: form.has("showZeroRows"),
          showAccountCodes: form.has("showAccountCodes"),
          sections: form.getAll("sections"),
        }),
      });
      setEditingTemplate(undefined);
      setActiveTemplateId(saved._id);
      setTab(saved.reportType);
      show(editingTemplate ? "Report layout updated." : "Report layout saved.");
      await loadTemplates();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not save the report layout.",
        "error",
      );
    }
  }

  async function deleteTemplate() {
    if (!editingTemplate || !window.confirm(`Delete ${editingTemplate.name}?`))
      return;
    try {
      await apiRequest("/api/report-templates", {
        method: "POST",
        body: JSON.stringify({
          action: "DELETE",
          id: editingTemplate._id,
          expectedVersion: editingTemplate.version,
        }),
      });
      setEditingTemplate(undefined);
      setActiveTemplateId("");
      show("Report layout deleted.");
      await loadTemplates();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not delete the report layout.",
        "error",
      );
    }
  }

  function applyPreset(preset: "MONTH" | "QUARTER" | "YEAR") {
    const [year, month] = today.split("-").map(Number);
    const startMonth =
      preset === "MONTH"
        ? month
        : preset === "QUARTER"
          ? Math.floor((month - 1) / 3) * 3 + 1
          : 1;
    setFrom(`${year}-${String(startMonth).padStart(2, "0")}-01`);
    setTo(today);
  }

  function exportCsv() {
    if (!data) return;
    if (tab === "COUNTRY") {
      show("Use Download country report CSV inside the country report desk.");
      return;
    }
    const rows: Array<Array<string | number>> = [
      ["Report", REPORT_TABS.find((item) => item.key === tab)?.label || tab],
      ["Period", `${data.period.from} to ${data.period.to}`],
      ["Currency", data.period.currency],
      [],
    ];
    if (tab === "PROFIT_LOSS") {
      rows.push(
        ["Section", "Code", "Account", "Amount"],
        ...data.profitAndLoss.revenue.map((row) => [
          "Revenue",
          row.code,
          row.name,
          row.amount,
        ]),
        ...data.profitAndLoss.expenses.map((row) => [
          "Expense",
          row.code,
          row.name,
          row.amount,
        ]),
        ["Net profit", "", "", data.profitAndLoss.netProfit],
      );
    } else if (tab === "BALANCE_SHEET") {
      rows.push(
        ["Section", "Code", "Account", "Amount"],
        ...data.balanceSheet.assets.map((row) => [
          "Asset",
          row.code,
          row.name,
          row.amount,
        ]),
        ...data.balanceSheet.liabilities.map((row) => [
          "Liability",
          row.code,
          row.name,
          row.amount,
        ]),
        ...data.balanceSheet.equity.map((row) => [
          "Equity",
          row.code,
          row.name,
          row.amount,
        ]),
      );
    } else if (tab === "CASH_FLOW") {
      rows.push(
        ["Section", "Source", "Description", "Amount"],
        ...data.cashFlow.operating.map((row) => [
          "Operating",
          row.code,
          row.name,
          row.amount,
        ]),
        ...data.cashFlow.investing.map((row) => [
          "Investing",
          row.code,
          row.name,
          row.amount,
        ]),
        ...data.cashFlow.financing.map((row) => [
          "Financing",
          row.code,
          row.name,
          row.amount,
        ]),
        ...data.cashFlow.unclassified.map((row) => [
          "Unclassified",
          row.code,
          row.name,
          row.amount,
        ]),
        ["Closing cash", "", "", data.cashFlow.closingCash],
      );
    } else if (tab === "TRIAL_BALANCE") {
      rows.push(
        [
          "Code",
          "Account",
          "Type",
          "Opening debit",
          "Opening credit",
          "Period debit",
          "Period credit",
          "Closing debit",
          "Closing credit",
        ],
        ...data.trialBalance.rows.map((row) => [
          row.code,
          row.name,
          row.type,
          row.openingDebit,
          row.openingCredit,
          row.periodDebit,
          row.periodCredit,
          row.closingDebit,
          row.closingCredit,
        ]),
      );
    } else if (tab === "AGING") {
      rows.push(
        ["Ledger", "Document", "Party", "Due date", "Days overdue", "Balance"],
        ...data.aging.receivables.rows.map((row) => [
          "Receivable",
          row.documentNo,
          row.party,
          row.dueDate,
          row.daysPastDue,
          row.balance,
        ]),
        ...data.aging.payables.rows.map((row) => [
          "Payable",
          row.documentNo,
          row.party,
          row.dueDate,
          row.daysPastDue,
          row.balance,
        ]),
      );
    } else {
      rows.push(
        ["Metric", "Value"],
        ["Net profit", data.profitAndLoss.netProfit],
        ["Total assets", data.balanceSheet.totalAssets],
        ["Closing cash", data.cashFlow.closingCash],
        ["Receivables", data.aging.receivables.total],
        ["Payables", data.aging.payables.total],
        ["Inventory at cost", data.operations.inventoryValue.cost],
      );
    }
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    const href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `financial-report-${tab.toLowerCase()}-${data.period.from}-${data.period.to}.csv`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  const maxTrend = useMemo(
    () =>
      Math.max(
        ...(data?.operations.trend.flatMap((point) => [
          Math.abs(point.revenue),
          Math.abs(point.cost),
        ]) || [1]),
        1,
      ),
    [data],
  );
  const designerLabel: Record<ReportLayoutType, string> = {
    PROFIT_LOSS: "Profit & loss",
    BALANCE_SHEET: "Balance sheet",
    CASH_FLOW: "Cash flow statement",
    TRIAL_BALANCE: "Trial balance",
    AGING: "Receivables & payables aging",
  };

  return (
    <div className="page page-enter financial-reports-page">
      <PageHeader
        eyebrow="FINANCIAL CONTROL"
        title="Financial reports"
        description="Posted-ledger statements, operational aging and a visible close check for every reporting period."
        action={
          <div className="report-actions report-layout-actions">
            <select
              aria-label="Saved report layout"
              value={activeTemplateId}
              onChange={(event) => {
                const template = templates.find(
                  (item) => item._id === event.target.value,
                );
                setActiveTemplateId(event.target.value);
                if (template) setTab(template.reportType);
              }}
            >
              <option value="">Standard layout</option>
              {templates.map((template) => (
                <option key={template._id} value={template._id}>
                  {template.name}
                </option>
              ))}
            </select>
            {canDesign ? (
              <button
                className="button button-secondary"
                onClick={openDesigner}
              >
                <SlidersHorizontal />
                Design layout
              </button>
            ) : null}
            <button
              className="button button-secondary"
              onClick={exportCsv}
              disabled={!data}
            >
              <Download />
              Export CSV
            </button>
            <button
              className="button button-secondary"
              onClick={() => window.print()}
              disabled={!data}
            >
              <Printer />
              Print
            </button>
          </div>
        }
      />
      {notice ? <Notice {...notice} /> : null}
      <section className="report-period-control">
        <CalendarRange />
        <label>
          <span>From</span>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <div>
          <button onClick={() => applyPreset("MONTH")}>This month</button>
          <button onClick={() => applyPreset("QUARTER")}>This quarter</button>
          <button onClick={() => applyPreset("YEAR")}>This year</button>
        </div>
        {data ? (
          <small>
            {data.period.currency} · {data.period.timeZone} · {data.period.days}{" "}
            days
          </small>
        ) : null}
      </section>
      {loading || !data ? (
        <LoadingPanel label="Closing the ledger and building statements…" />
      ) : (
        <>
          <section
            className={`report-close-ribbon ${data.integrity.balanced ? "balanced" : "attention"}`}
          >
            <div className="close-mark">
              {data.integrity.balanced ? <CheckCircle2 /> : <AlertTriangle />}
            </div>
            <div>
              <span>ASSETS</span>
              <strong>{money.format(data.balanceSheet.totalAssets)}</strong>
            </div>
            <b>=</b>
            <div>
              <span>LIABILITIES</span>
              <strong>
                {money.format(data.balanceSheet.totalLiabilities)}
              </strong>
            </div>
            <b>+</b>
            <div>
              <span>EQUITY + EARNINGS</span>
              <strong>{money.format(data.balanceSheet.totalEquity)}</strong>
            </div>
            <p>
              <strong>
                {data.integrity.balanced
                  ? "Ledger balanced"
                  : "Close requires attention"}
              </strong>
              <span>
                {data.integrity.journalCount} posted journals in period ·{" "}
                {data.integrity.unbalancedEntries} unbalanced entries · equation
                variance {money.format(data.integrity.equationDifference)}
              </span>
            </p>
          </section>
          <nav className="report-tabs" aria-label="Financial report">
            <div role="tablist">
              {REPORT_TABS.map((item) => (
                <button
                  key={item.key}
                  role="tab"
                  aria-selected={tab === item.key}
                  className={tab === item.key ? "active" : ""}
                  onClick={() => setTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </nav>
          {tab === "COUNTRY" ? (
            <CountryReportPanel
              key={`${data.period.from}-${data.period.to}-${profile.countryCode}`}
              data={data}
              countryCode={profile.countryCode}
              company={profile.legalEntityName || profile.businessName}
            />
          ) : null}

          {tab === "OVERVIEW" ? (
            <div className="report-tab-panel">
              <section className="stat-grid">
                <StatCard
                  label="Net profit"
                  value={money.format(data.profitAndLoss.netProfit)}
                  detail={`${data.profitAndLoss.margin.toFixed(1)}% net margin`}
                  icon={<CircleDollarSign />}
                />
                <StatCard
                  label="Gross profit"
                  value={money.format(data.profitAndLoss.grossProfit)}
                  detail={`${data.operations.summary.transactions} completed sales`}
                  tone="sand"
                  icon={<TrendingUp />}
                />
                <StatCard
                  label="Stock at cost"
                  value={money.format(data.operations.inventoryValue.cost)}
                  detail={`${data.operations.inventoryValue.units} units on hand`}
                  tone="ink"
                  icon={<Boxes />}
                />
                <StatCard
                  label="Working capital due"
                  value={money.format(
                    data.aging.receivables.total - data.aging.payables.total,
                  )}
                  detail={`${data.aging.receivables.count} AR · ${data.aging.payables.count} AP`}
                  tone="plum"
                  icon={<Landmark />}
                />
              </section>
              <section className="reports-grid">
                <article className="panel report-trend">
                  <header className="panel-header">
                    <div>
                      <span className="eyebrow">OPERATING PERFORMANCE</span>
                      <h2>Sales revenue & cost</h2>
                    </div>
                    <span className="panel-note">
                      {data.period.from} — {data.period.to}
                    </span>
                  </header>
                  {data.operations.trend.length ? (
                    <div className="bar-chart">
                      {data.operations.trend.map((point) => (
                        <div
                          className="bar-column"
                          key={point._id}
                          title={`${point._id}: ${money.format(point.revenue)}`}
                        >
                          <div className="bar-pair">
                            <i
                              style={{
                                height: `${(Math.abs(point.cost) / maxTrend) * 100}%`,
                              }}
                            />
                            <b
                              style={{
                                height: `${(Math.abs(point.revenue) / maxTrend) * 100}%`,
                              }}
                            />
                          </div>
                          <span>{point._id}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="No sales in this period"
                      detail="Choose another period or post sales through POS."
                    />
                  )}
                </article>
                <article className="panel">
                  <header className="panel-header">
                    <div>
                      <span className="eyebrow">TENDER MIX</span>
                      <h2>Payments received</h2>
                    </div>
                    <ReceiptText />
                  </header>
                  {data.operations.payments.length ? (
                    <div className="payment-report">
                      {data.operations.payments.map((payment) => (
                        <div key={payment._id}>
                          <span>{payment._id}</span>
                          <div>
                            <i
                              style={{
                                width: `${Math.max(4, data.operations.summary.revenue ? (payment.value / data.operations.summary.revenue) * 100 : 4)}%`,
                              }}
                            />
                          </div>
                          <strong>{money.format(payment.value)}</strong>
                          <small>{payment.count} sales</small>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="No payment data"
                      detail="Completed POS transactions will be grouped here."
                    />
                  )}
                </article>
              </section>
              <section className="report-summary-strip">
                <div>
                  <span>Output tax charged</span>
                  <strong>{money.format(data.tax.outputTaxCharged)}</strong>
                </div>
                <div>
                  <span>Input tax recoverable</span>
                  <strong>{money.format(data.tax.inputTaxRecoverable)}</strong>
                </div>
                <div>
                  <span>Net tax movement</span>
                  <strong>{money.format(data.tax.netMovement)}</strong>
                </div>
                <div>
                  <span>Draft invoices excluded from AR</span>
                  <strong>{data.operations.draftInvoiceCount}</strong>
                </div>
              </section>
            </div>
          ) : null}

          {tab === "PROFIT_LOSS" ? (
            <section className={statementClass}>
              <header>
                <span>PROFIT & LOSS</span>
                <h2>
                  {activeTemplate?.title ||
                    `For ${data.period.from} to ${data.period.to}`}
                </h2>
                <small>
                  {activeTemplate?.subtitle ||
                    `Accrual movements from posted journal entries · ${data.period.currency}`}
                </small>
              </header>
              {includesSection("REVENUE") ? (
                <div className="statement-section">
                  <h3>Revenue</h3>
                  <StatementLines
                    rows={data.profitAndLoss.revenue}
                    money={money}
                    showZero={activeTemplate?.showZeroRows}
                    showCodes={activeTemplate?.showAccountCodes}
                  />
                  <StatementTotal
                    label="Total revenue"
                    value={data.profitAndLoss.totalRevenue}
                    money={money}
                  />
                </div>
              ) : null}
              {includesSection("COST_OF_SALES") ? (
                <div className="statement-section">
                  <h3>Cost of sales</h3>
                  <StatementLines
                    rows={data.profitAndLoss.expenses.filter(
                      (row) => row.code === "5000",
                    )}
                    money={money}
                    showZero={activeTemplate?.showZeroRows}
                    showCodes={activeTemplate?.showAccountCodes}
                  />
                  <StatementTotal
                    label="Gross profit"
                    value={data.profitAndLoss.grossProfit}
                    money={money}
                  />
                </div>
              ) : null}
              {includesSection("OPERATING_EXPENSES") ? (
                <div className="statement-section">
                  <h3>Operating and other expenses</h3>
                  <StatementLines
                    rows={data.profitAndLoss.expenses.filter(
                      (row) => row.code !== "5000",
                    )}
                    money={money}
                    showZero={activeTemplate?.showZeroRows}
                    showCodes={activeTemplate?.showAccountCodes}
                  />
                  <StatementTotal
                    label="Total expenses"
                    value={data.profitAndLoss.totalExpenses}
                    money={money}
                  />
                </div>
              ) : null}
              {includesSection("NET_PROFIT") ? (
                <StatementTotal
                  label="Net profit / (loss)"
                  value={data.profitAndLoss.netProfit}
                  money={money}
                  grand
                />
              ) : null}
            </section>
          ) : null}

          {tab === "BALANCE_SHEET" ? (
            <section className={statementClass}>
              <header>
                <span>BALANCE SHEET</span>
                <h2>{activeTemplate?.title || `As at ${data.period.to}`}</h2>
                <small>
                  {activeTemplate?.subtitle ||
                    `Posted balances including cumulative earnings · ${data.period.currency}`}
                </small>
              </header>
              <div className="statement-columns">
                {includesSection("ASSETS") ? (
                  <div className="statement-section">
                    <h3>Assets</h3>
                    <StatementLines
                      rows={data.balanceSheet.assets}
                      money={money}
                      showZero={activeTemplate?.showZeroRows}
                      showCodes={activeTemplate?.showAccountCodes}
                    />
                    <StatementTotal
                      label="Total assets"
                      value={data.balanceSheet.totalAssets}
                      money={money}
                      grand
                    />
                  </div>
                ) : (
                  <div />
                )}
                <div>
                  {includesSection("LIABILITIES") ? (
                    <div className="statement-section">
                      <h3>Liabilities</h3>
                      <StatementLines
                        rows={data.balanceSheet.liabilities}
                        money={money}
                        showZero={activeTemplate?.showZeroRows}
                        showCodes={activeTemplate?.showAccountCodes}
                      />
                      <StatementTotal
                        label="Total liabilities"
                        value={data.balanceSheet.totalLiabilities}
                        money={money}
                      />
                    </div>
                  ) : null}
                  {includesSection("EQUITY") ? (
                    <div className="statement-section">
                      <h3>Equity</h3>
                      <StatementLines
                        rows={data.balanceSheet.equity}
                        money={money}
                        showZero={activeTemplate?.showZeroRows}
                        showCodes={activeTemplate?.showAccountCodes}
                      />
                      <StatementTotal
                        label="Total equity + earnings"
                        value={data.balanceSheet.totalEquity}
                        money={money}
                        grand
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {tab === "CASH_FLOW" ? (
            <section className={statementClass}>
              <header>
                <span>CASH FLOW</span>
                <h2>
                  {activeTemplate?.title ||
                    `For ${data.period.from} to ${data.period.to}`}
                </h2>
                <small>
                  {activeTemplate?.subtitle ||
                    `Direct cash-equivalent movements from posted journals · ${data.period.currency}`}
                </small>
              </header>
              {includesSection("OPENING") ? (
                <StatementTotal
                  label="Opening cash and bank"
                  value={data.cashFlow.openingCash}
                  money={money}
                />
              ) : null}
              {includesSection("OPERATING") ? (
                <div className="statement-section">
                  <h3>Operating activities</h3>
                  <StatementLines
                    rows={data.cashFlow.operating}
                    money={money}
                    showZero={activeTemplate?.showZeroRows}
                    showCodes={activeTemplate?.showAccountCodes}
                  />
                  <StatementTotal
                    label="Net operating cash"
                    value={data.cashFlow.operatingCash}
                    money={money}
                  />
                </div>
              ) : null}
              <div className="statement-columns">
                {includesSection("INVESTING") ? (
                  <div className="statement-section">
                    <h3>Investing activities</h3>
                    <StatementLines
                      rows={data.cashFlow.investing}
                      money={money}
                      showZero={activeTemplate?.showZeroRows}
                      showCodes={activeTemplate?.showAccountCodes}
                    />
                    <StatementTotal
                      label="Net investing cash"
                      value={data.cashFlow.investingCash}
                      money={money}
                    />
                  </div>
                ) : (
                  <div />
                )}
                {includesSection("FINANCING") ? (
                  <div className="statement-section">
                    <h3>Financing activities</h3>
                    <StatementLines
                      rows={data.cashFlow.financing}
                      money={money}
                      showZero={activeTemplate?.showZeroRows}
                      showCodes={activeTemplate?.showAccountCodes}
                    />
                    <StatementTotal
                      label="Net financing cash"
                      value={data.cashFlow.financingCash}
                      money={money}
                    />
                  </div>
                ) : null}
              </div>
              {includesSection("UNCLASSIFIED") &&
              data.cashFlow.unclassified.some((row) => row.amount !== 0) ? (
                <div className="statement-section attention-section">
                  <h3>Manual journals requiring classification</h3>
                  <StatementLines
                    rows={data.cashFlow.unclassified}
                    money={money}
                    showZero={activeTemplate?.showZeroRows}
                    showCodes={activeTemplate?.showAccountCodes}
                  />
                  <StatementTotal
                    label="Unclassified cash"
                    value={data.cashFlow.unclassifiedCash}
                    money={money}
                  />
                </div>
              ) : null}
              {includesSection("CLOSING") ? (
                <>
                  <StatementTotal
                    label="Net change in cash"
                    value={data.cashFlow.netCashMovement}
                    money={money}
                  />
                  <StatementTotal
                    label="Closing cash and bank"
                    value={data.cashFlow.closingCash}
                    money={money}
                    grand
                  />
                </>
              ) : null}
            </section>
          ) : null}

          {tab === "TRIAL_BALANCE" ? (
            <section className={`${statementClass} trial-panel`}>
              <header className="panel-header">
                <div>
                  <span className="eyebrow">CONTROL REPORT</span>
                  <h2>{activeTemplate?.title || "Trial balance"}</h2>
                  {activeTemplate?.subtitle ? (
                    <small>{activeTemplate.subtitle}</small>
                  ) : null}
                </div>
                <Scale />
              </header>
              <div className="report-table-wrap">
                <table className="report-table trial-table">
                  <thead>
                    <tr>
                      {activeTemplate?.showAccountCodes !== false ? (
                        <th>Code</th>
                      ) : null}
                      <th>Account</th>
                      <th>Type</th>
                      {includesSection("OPENING") ? (
                        <>
                          <th className="number">Opening Dr</th>
                          <th className="number">Opening Cr</th>
                        </>
                      ) : null}
                      {includesSection("PERIOD") ? (
                        <>
                          <th className="number">Period Dr</th>
                          <th className="number">Period Cr</th>
                        </>
                      ) : null}
                      {includesSection("CLOSING") ? (
                        <>
                          <th className="number">Closing Dr</th>
                          <th className="number">Closing Cr</th>
                        </>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.trialBalance.rows
                      .filter(
                        (row) =>
                          !activeTemplate ||
                          activeTemplate.showZeroRows ||
                          row.openingDebit ||
                          row.openingCredit ||
                          row.periodDebit ||
                          row.periodCredit ||
                          row.closingDebit ||
                          row.closingCredit,
                      )
                      .map((row) => (
                        <tr key={row.code}>
                          {activeTemplate?.showAccountCodes !== false ? (
                            <td>
                              <b>{row.code}</b>
                            </td>
                          ) : null}
                          <td>{row.name}</td>
                          <td>{row.type}</td>
                          {includesSection("OPENING") ? (
                            <>
                              <td className="number">
                                {row.openingDebit
                                  ? money.format(row.openingDebit)
                                  : "—"}
                              </td>
                              <td className="number">
                                {row.openingCredit
                                  ? money.format(row.openingCredit)
                                  : "—"}
                              </td>
                            </>
                          ) : null}
                          {includesSection("PERIOD") ? (
                            <>
                              <td className="number">
                                {row.periodDebit
                                  ? money.format(row.periodDebit)
                                  : "—"}
                              </td>
                              <td className="number">
                                {row.periodCredit
                                  ? money.format(row.periodCredit)
                                  : "—"}
                              </td>
                            </>
                          ) : null}
                          {includesSection("CLOSING") ? (
                            <>
                              <td className="number">
                                {row.closingDebit
                                  ? money.format(row.closingDebit)
                                  : "—"}
                              </td>
                              <td className="number">
                                {row.closingCredit
                                  ? money.format(row.closingCredit)
                                  : "—"}
                              </td>
                            </>
                          ) : null}
                        </tr>
                      ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th
                        colSpan={
                          activeTemplate?.showAccountCodes === false ? 2 : 3
                        }
                      >
                        Totals
                      </th>
                      {includesSection("OPENING") ? (
                        <>
                          <th className="number">
                            {money.format(
                              data.trialBalance.totals.openingDebit,
                            )}
                          </th>
                          <th className="number">
                            {money.format(
                              data.trialBalance.totals.openingCredit,
                            )}
                          </th>
                        </>
                      ) : null}
                      {includesSection("PERIOD") ? (
                        <>
                          <th className="number">
                            {money.format(data.trialBalance.totals.periodDebit)}
                          </th>
                          <th className="number">
                            {money.format(
                              data.trialBalance.totals.periodCredit,
                            )}
                          </th>
                        </>
                      ) : null}
                      {includesSection("CLOSING") ? (
                        <>
                          <th className="number">
                            {money.format(
                              data.trialBalance.totals.closingDebit,
                            )}
                          </th>
                          <th className="number">
                            {money.format(
                              data.trialBalance.totals.closingCredit,
                            )}
                          </th>
                        </>
                      ) : null}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          ) : null}

          {tab === "AGING" ? (
            <section className={statementClass}>
              <header>
                <span>WORKING CAPITAL</span>
                <h2>
                  {activeTemplate?.title || "Receivables & payables aging"}
                </h2>
                <small>
                  {activeTemplate?.subtitle ||
                    `As at ${data.period.to} · ${data.period.currency}`}
                </small>
              </header>
              <div className="aging-report-grid">
                {includesSection("RECEIVABLES") ? (
                  <AgingPanel
                    title="Accounts receivable aging"
                    report={data.aging.receivables}
                    money={money}
                  />
                ) : null}
                {includesSection("PAYABLES") ? (
                  <AgingPanel
                    title="Accounts payable aging"
                    report={data.aging.payables}
                    money={money}
                  />
                ) : null}
                <div className="aging-note">
                  <WalletCards />
                  <p>
                    <strong>
                      Operational aging is separate from the posted ledger.
                    </strong>
                    <span>
                      Receivables include sent, unpaid customer invoices. Draft
                      invoices are excluded. Payables use supplier bills at
                      base-currency carrying value.
                    </span>
                  </p>
                </div>
              </div>
            </section>
          ) : null}
        </>
      )}
      <Modal
        open={editingTemplate !== undefined}
        onClose={() => setEditingTemplate(undefined)}
        title={editingTemplate ? "Edit report layout" : "Create report layout"}
        kicker="REPORT DESIGNER"
      >
        <form
          className="modal-form report-designer-form"
          key={`${editingTemplate?._id || "new"}-${designerType}`}
          onSubmit={saveTemplate}
        >
          <div className="report-designer-intro">
            <SlidersHorizontal />
            <div>
              <strong>Shape the report, not the ledger.</strong>
              <span>
                Layouts change headings, visible sections and print treatment.
                Posted figures remain read-only.
              </span>
            </div>
          </div>
          <div className="form-grid two">
            <label className="field">
              <span>Report</span>
              <select
                value={designerType}
                onChange={(event) =>
                  setDesignerType(event.target.value as ReportLayoutType)
                }
              >
                {Object.entries(designerLabel).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Layout name</span>
              <input
                name="name"
                defaultValue={
                  editingTemplate?.name ||
                  `${designerLabel[designerType]} layout`
                }
                minLength={2}
                maxLength={80}
                required
              />
            </label>
            <label className="field">
              <span>Printed title</span>
              <input
                name="title"
                defaultValue={
                  editingTemplate?.title || designerLabel[designerType]
                }
                minLength={2}
                maxLength={120}
                required
              />
            </label>
            <label className="field">
              <span>Supporting line</span>
              <input
                name="subtitle"
                defaultValue={
                  editingTemplate?.subtitle ||
                  "Prepared from posted ledger entries"
                }
                maxLength={240}
              />
            </label>
            <label className="field">
              <span>Paper orientation</span>
              <select
                name="orientation"
                defaultValue={
                  editingTemplate?.orientation ||
                  (designerType === "TRIAL_BALANCE" ? "LANDSCAPE" : "PORTRAIT")
                }
              >
                <option value="PORTRAIT">Portrait</option>
                <option value="LANDSCAPE">Landscape</option>
              </select>
            </label>
            <label className="field">
              <span>Accent</span>
              <select
                name="accent"
                defaultValue={editingTemplate?.accent || "MATCHA"}
              >
                <option value="MATCHA">Matcha green</option>
                <option value="INK">Accounting ink</option>
                <option value="PLUM">Ume plum</option>
              </select>
            </label>
          </div>
          <fieldset className="report-section-picker">
            <legend>Visible sections</legend>
            {REPORT_LAYOUTS[designerType].map((section) => (
              <label className="check-row compact" key={section}>
                <input
                  type="checkbox"
                  name="sections"
                  value={section}
                  defaultChecked={
                    editingTemplate
                      ? editingTemplate.reportType === designerType &&
                        editingTemplate.sections.includes(section)
                      : true
                  }
                />
                <span>{section.replaceAll("_", " ").toLocaleLowerCase()}</span>
              </label>
            ))}
          </fieldset>
          <div className="form-grid two">
            <label className="check-row compact">
              <input
                type="checkbox"
                name="showAccountCodes"
                defaultChecked={editingTemplate?.showAccountCodes ?? true}
              />
              <span>Show account codes</span>
            </label>
            <label className="check-row compact">
              <input
                type="checkbox"
                name="showZeroRows"
                defaultChecked={editingTemplate?.showZeroRows ?? false}
              />
              <span>Show zero-value rows</span>
            </label>
          </div>
          <footer>
            {editingTemplate ? (
              <button
                type="button"
                className="button button-secondary danger"
                onClick={() => void deleteTemplate()}
              >
                <Trash2 />
                Delete
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setEditingTemplate(undefined)}
            >
              Cancel
            </button>
            <button className="button button-primary">Save layout</button>
          </footer>
        </form>
      </Modal>
    </div>
  );
}
