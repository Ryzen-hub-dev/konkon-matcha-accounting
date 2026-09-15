"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { Banknote, Eye, ReceiptText, Search, ShoppingBasket } from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { useBusiness } from "@/components/business-context";
import { ScannerBridge } from "./scanner-bridge";
import { useRouter } from "next/navigation";

type Sale = {
  _id: string;
  receiptNo: string;
  memberName?: string;
  cashierName?: string;
  counterCode?: string;
  counterName?: string;
  total: number;
  refundedAmount?: number;
  paymentMethod: string;
  paymentMethodName?: string;
  templateName?: string;
  status: string;
  createdAt: string;
};

export function ReceiptsView({ canSell = false }: { canSell?: boolean }) {
  const router = useRouter();
  const { money, shortDate, dateTime } = useBusiness();
  const [sales, setSales] = useState<Sale[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const { notice, show } = useNotice();

  async function load(search = "") {
    setLoading(true);
    try {
      setSales(await apiRequest<Sale[]>(`/api/sales${search ? `?q=${encodeURIComponent(search)}` : ""}`));
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load receipt history.", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(query.trim());
  }

  const today = new Date().toDateString();
  const todaySales = sales.filter((sale) => new Date(sale.createdAt).toDateString() === today);

  return <div className="page page-enter">
    <PageHeader eyebrow="SALES ARCHIVE" title="Receipts" description="Find, verify and reprint the exact paper issued at the counter." action={canSell ? <Link className="button button-primary" href="/pos"><ShoppingBasket size={17} />New sale</Link> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <ScannerBridge contextLabel="Receipts" purpose="RECEIPTS" placeholder="Scan receipt QR or enter receipt number" onFeedback={show} onScan={async code => {
      try { const match = await apiRequest<{ id: string }>("/api/receipt-lookup", { method: "POST", body: JSON.stringify({ code }) }); router.push(`/receipts/${match.id}`); }
      catch (reason) { show(reason instanceof Error ? reason.message : "Receipt not found.", "error"); }
    }} />
    <section className="mini-stat-row"><article><ReceiptText /><span>Receipts shown</span><strong>{sales.length}</strong></article><article><Banknote /><span>Net value shown</span><strong>{money.format(sales.reduce((sum, sale) => sum + sale.total - Number(sale.refundedAmount || 0), 0))}</strong></article><article><ShoppingBasket /><span>Today</span><strong>{todaySales.length}</strong></article></section>
    <section className="panel resource-panel">
      <div className="resource-toolbar"><form className="search-box receipt-search" onSubmit={search}><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Receipt, member, cashier, counter or payment reference" /><button>Search</button></form><span>Latest 200 receipts</span></div>
      {loading ? <LoadingPanel label="Reading the receipt roll…" /> : sales.length ? <div className="data-list receipt-history-list"><div className="data-list-head"><span>Receipt</span><span>Customer</span><span>Payment</span><span>Net amount</span><span>Status</span><span>Action</span></div>{sales.map((sale) => <div className="data-row" key={sale._id}><div><strong>{sale.receiptNo}</strong><small>{sale.counterName ? `${sale.counterCode} · ${sale.counterName}` : sale.templateName || "Legacy receipt"} · {shortDate.format(new Date(sale.createdAt))}</small></div><div><strong>{sale.memberName || "Walk-in guest"}</strong><small>{sale.cashierName || "Cashier not recorded"}</small></div><div><strong>{sale.paymentMethodName || sale.paymentMethod}</strong><small>{dateTime.format(new Date(sale.createdAt))}</small></div><div><strong>{money.format(Math.max(0, sale.total - Number(sale.refundedAmount || 0)))}</strong>{sale.refundedAmount ? <small>{money.format(sale.refundedAmount)} refunded</small> : null}</div><StatusPill value={sale.status} /><Link className="button button-quiet" href={`/receipts/${sale._id}`}><Eye size={14} />View / print</Link></div>)}</div> : <EmptyState title="No receipts found" detail={query ? "Try a receipt number, customer, cashier or counter." : "Completed POS sales will appear here."} action={query ? <button className="button button-secondary" onClick={() => { setQuery(""); void load(); }}>Clear search</button> : canSell ? <Link className="button button-primary" href="/pos">Open the register</Link> : undefined} />}
    </section>
  </div>;
}
