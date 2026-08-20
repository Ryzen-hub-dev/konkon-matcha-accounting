"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, CircleDollarSign, Landmark, ReceiptText, TrendingUp } from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, money, Notice, PageHeader, StatCard, useNotice } from "@/components/ui";

type ReportData = {
  days: number;
  summary: { revenue: number; cost: number; grossProfit: number; margin: number; transactions: number; items: number };
  trend: Array<{ _id: string; revenue: number; cost: number }>;
  payments: Array<{ _id: string; value: number; count: number }>;
  inventoryValue: { retail: number; cost: number; units: number };
  receivables: { outstanding: number; count: number };
};

export function ReportsView() {
  const [days, setDays] = useState(30); const [data, setData] = useState<ReportData | null>(null); const [loading, setLoading] = useState(true); const { notice, show } = useNotice();
  useEffect(() => { setLoading(true); apiRequest<ReportData>(`/api/reports?days=${days}`).then(setData).catch((reason) => show(reason.message, "error")).finally(() => setLoading(false)); }, [days, show]);
  const max = useMemo(() => Math.max(...(data?.trend.map((point) => point.revenue) || [1]), 1), [data]);
  return <div className="page page-enter">
    <PageHeader eyebrow="MANAGEMENT REPORTS" title="Reports" description="A clear read on sales, margin, stock value and money still to collect." action={<div className="period-switch">{[7, 30, 90].map((value) => <button key={value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>{value} days</button>)}</div>} />
    {notice ? <Notice {...notice} /> : null}
    {loading || !data ? <LoadingPanel label="Brewing the management report…" /> : <>
      <section className="stat-grid"><StatCard label="Revenue" value={money.format(data.summary.revenue)} detail={`${data.summary.transactions} completed sales`} icon={<CircleDollarSign />} /><StatCard label="Gross profit" value={money.format(data.summary.grossProfit)} detail={`${data.summary.margin.toFixed(1)}% gross margin`} tone="sand" icon={<TrendingUp />} /><StatCard label="Stock at cost" value={money.format(data.inventoryValue.cost)} detail={`${data.inventoryValue.units} units on hand`} tone="ink" icon={<Boxes />} /><StatCard label="Receivables" value={money.format(data.receivables.outstanding)} detail={`${data.receivables.count} open invoices`} tone="plum" icon={<Landmark />} /></section>
      <section className="reports-grid"><article className="panel report-trend"><header className="panel-header"><div><span className="eyebrow">PERFORMANCE</span><h2>Revenue & cost</h2></div><span className="panel-note">LAST {days} DAYS</span></header>{data.trend.length ? <div className="bar-chart">{data.trend.map((point) => <div className="bar-column" key={point._id} title={`${point._id}: ${money.format(point.revenue)}`}><div className="bar-pair"><i style={{ height: `${(point.cost / max) * 100}%` }} /><b style={{ height: `${(point.revenue / max) * 100}%` }} /></div><span>{new Date(`${point._id}T00:00:00`).toLocaleDateString("en-SG", { day: "2-digit", month: "short" })}</span></div>)}</div> : <EmptyState title="No sales in this period" detail="Choose another period or start ringing sales through POS." />}</article>
      <article className="panel"><header className="panel-header"><div><span className="eyebrow">TENDER MIX</span><h2>Payments received</h2></div><ReceiptText /></header>{data.payments.length ? <div className="payment-report">{data.payments.map((payment, index) => <div key={payment._id}><span style={{ "--tone": `${index}` } as React.CSSProperties}>{payment._id}</span><div><i style={{ width: `${Math.max(4, (payment.value / data.summary.revenue) * 100)}%` }} /></div><strong>{money.format(payment.value)}</strong><small>{payment.count} sales</small></div>)}</div> : <EmptyState title="No payment data" detail="Completed POS transactions will be grouped here." />}</article></section>
      <section className="report-summary-strip"><div><span>Cost of goods sold</span><strong>{money.format(data.summary.cost)}</strong></div><div><span>Items served</span><strong>{data.summary.items.toLocaleString()}</strong></div><div><span>Average receipt</span><strong>{money.format(data.summary.transactions ? data.summary.revenue / data.summary.transactions : 0)}</strong></div><div><span>Stock retail value</span><strong>{money.format(data.inventoryValue.retail)}</strong></div></section>
    </>}
  </div>;
}
