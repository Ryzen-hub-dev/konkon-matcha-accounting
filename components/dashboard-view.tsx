"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Boxes, CircleDollarSign, ReceiptText, ShoppingBag, Users } from "lucide-react";
import { apiRequest, dateTime, EmptyState, LoadingPanel, money, PageHeader, StatCard } from "@/components/ui";

type DashboardData = {
  today: { revenue: number; transactions: number; averageSale: number };
  month: { revenue: number; transactions: number };
  memberCount: number;
  lowStockCount: number;
  recentSales: Array<{ _id: string; receiptNo: string; memberName: string; total: number; paymentMethod: string; createdAt: string }>;
  dailySales: Array<{ _id: string; total: number }>;
  topProducts: Array<{ _id: string; name: string; quantity: number; revenue: number }>;
};

function SalesChart({ points }: { points: DashboardData["dailySales"] }) {
  const values = points.length ? points : [{ _id: new Date().toISOString().slice(0, 10), total: 0 }];
  const max = Math.max(...values.map((point) => point.total), 1);
  const coords = values.map((point, index) => ({ x: values.length === 1 ? 50 : 6 + (index / (values.length - 1)) * 88, y: 82 - (point.total / max) * 62, ...point }));
  const path = coords.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  return <div className="chart-wrap">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Seven day sales trend">
      <path className="chart-grid" d="M 0 20 H 100 M 0 50 H 100 M 0 80 H 100" />
      <path className="chart-line-shadow" d={path} /><path className="chart-line" d={path} />
      {coords.map((point) => <circle key={point._id} cx={point.x} cy={point.y} r="1.7" />)}
    </svg>
    <div className="chart-labels">{coords.map((point) => <span key={point._id}>{new Date(`${point._id}T00:00:00`).toLocaleDateString("en-SG", { weekday: "short" })}</span>)}</div>
  </div>;
}

export function DashboardView() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest<DashboardData>("/api/dashboard").then(setData).catch((reason) => setError(reason.message)); }, []);
  const greeting = useMemo(() => { const hour = new Date().getHours(); return hour < 12 ? "Ohayō" : hour < 18 ? "Good afternoon" : "Konbanwa"; }, []);
  if (!data && !error) return <div className="page"><LoadingPanel label="Whisking today’s numbers…" /></div>;
  if (error) return <div className="page"><EmptyState title="The ledger could not be reached" detail={error} /></div>;
  const value = data!;
  return <div className="page page-enter">
    <PageHeader eyebrow="TODAY AT KŌN-KŌN" title={`${greeting}. Here’s the pour.`} description="Sales, stock and member activity in Singapore time." action={<Link href="/pos" className="button button-primary"><ShoppingBag size={17} />New sale<ArrowUpRight size={16} /></Link>} />
    <section className="ledger-hero">
      <div className="hero-copy"><span className="eyebrow light">TODAY&apos;S TEA ROOM</span><strong>{money.format(value.today.revenue)}</strong><p>from {value.today.transactions} completed {value.today.transactions === 1 ? "order" : "orders"}</p><div className="hero-rule"><span>Average cup</span><b>{money.format(value.today.averageSale)}</b></div></div>
      <div className="whisk-orbit" aria-hidden="true"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-core">抹<span>MATCHĀ</span></div></div>
      <div className="hero-month"><span>THIS MONTH</span><strong>{money.format(value.month.revenue)}</strong><small>{value.month.transactions} transactions posted</small></div>
    </section>
    <section className="stat-grid">
      <StatCard label="Today’s sales" value={money.format(value.today.revenue)} detail={`${value.today.transactions} transactions`} icon={<CircleDollarSign />} />
      <StatCard label="Active members" value={value.memberCount.toLocaleString()} detail="Tea community" tone="sand" icon={<Users />} />
      <StatCard label="Low stock" value={String(value.lowStockCount)} detail={value.lowStockCount ? "Needs attention" : "Everything stocked"} tone={value.lowStockCount ? "plum" : "matcha"} icon={<Boxes />} />
      <StatCard label="Average sale" value={money.format(value.today.averageSale)} detail="Per receipt today" tone="ink" icon={<ReceiptText />} />
    </section>
    <section className="dashboard-grid">
      <article className="panel sales-panel"><header className="panel-header"><div><span className="eyebrow">SALES FLOW</span><h2>Seven-day rhythm</h2></div><span className="panel-note">SGD · DAILY</span></header><SalesChart points={value.dailySales} /></article>
      <article className="panel"><header className="panel-header"><div><span className="eyebrow">FRESHLY SERVED</span><h2>Recent receipts</h2></div><Link href="/reports">View all</Link></header>
        {value.recentSales.length ? <div className="receipt-list">{value.recentSales.map((sale) => <div className="receipt-row" key={sale._id}><div className="receipt-icon"><ReceiptText size={17} /></div><div><strong>{sale.memberName}</strong><span>{sale.receiptNo} · {dateTime.format(new Date(sale.createdAt))}</span></div><div><strong>{money.format(sale.total)}</strong><span>{sale.paymentMethod}</span></div></div>)}</div> : <EmptyState title="No cups rung up yet" detail="Complete the first sale from the POS and it will appear here." />}
      </article>
      <article className="panel top-products-panel"><header className="panel-header"><div><span className="eyebrow">THIS MONTH</span><h2>Best sellers</h2></div><span className="panel-note">BY REVENUE</span></header>
        {value.topProducts.length ? <div className="rank-list">{value.topProducts.map((product, index) => <div key={product._id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{product.name}</strong><small>{product.quantity} sold</small></div><b>{money.format(product.revenue)}</b></div>)}</div> : <EmptyState title="A clean whisk" detail="Best-selling products appear after the first transactions." />}
      </article>
    </section>
  </div>;
}
