"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeftRight, Boxes, ClipboardCheck, PackagePlus, Search, ShieldCheck, Trash2, TrendingDown } from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";

type Balance = { locationId: string; locationCode: string; locationName: string; quantity: number };
type Product = { _id: string; sku: string; name: string; unit: string; stock: number; locationTracked: boolean; batchTracked?: boolean; expiryWarningDays?: number; locationBalances: Balance[] };
type Location = { _id: string; code: string; name: string };
type Batch = {
  _id: string; productId: string; sku: string; productName: string; locationId: string; locationCode: string; locationName: string;
  lotNo: string; expiryDate: string; quantity: number; version: number; status: "EXPIRED" | "EXPIRING" | "HEALTHY" | "DEPLETED"; daysRemaining: number | null;
  supplierName?: string; goodsReceiptNo?: string;
  dailyDemand?: number; projectedAtRisk?: number; forecastRisk?: "EXPIRED" | "HIGH" | "MEDIUM" | "LOW"; predictedDepletionDate?: string | null;
  transferSuggestion?: { locationId: string; locationCode: string; locationName: string; quantity: number };
};
type BatchData = { products: Product[]; locations: Location[]; batches: Batch[]; today: string; counts: { trackedProducts: number; liveBatches: number; expiring: number; expired: number; atRiskUnits: number } };
type TraceRecord = { _id: string; receiptNo?: string; refundNo?: string; transferNo?: string; purchaseOrderNo?: string; supplierName?: string; locationCode?: string; sourceLocationCode?: string; destinationLocationCode?: string; status?: string; receivedAt?: string; createdAt?: string; dispatchedAt?: string; items: Array<{ name?: string; productName?: string; quantity: number }> };
type TraceEvent = { _id: string; eventNo: string; action: string; disposition?: string; locationCode?: string; quantity: number; reason: string; createdAt: string };
type TraceData = { lotNo: string; batches: Batch[]; receipts: TraceRecord[]; sales: TraceRecord[]; refunds: TraceRecord[]; transfers: TraceRecord[]; events: TraceEvent[] };

const emptyData: BatchData = { products: [], locations: [], batches: [], today: "", counts: { trackedProducts: 0, liveBatches: 0, expiring: 0, expired: 0, atRiskUnits: 0 } };

export function InventoryBatchesView({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<BatchData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [activating, setActivating] = useState<Product | null>(null);
  const [openingLots, setOpeningLots] = useState<Record<string, { lotNo: string; expiryDate: string }>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [addProductId, setAddProductId] = useState("");
  const [counting, setCounting] = useState<Batch | null>(null);
  const [disposing, setDisposing] = useState<Batch | null>(null);
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const { notice, show } = useNotice();

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    try { setData(await apiRequest<BatchData>("/api/inventory-batches")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load batch inventory.", "error"); }
    finally { if (showLoading) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const eligible = data.products.filter((product) => product.locationTracked && !product.batchTracked);
  const tracked = data.products.filter((product) => product.batchTracked);
  const selectedAddProduct = tracked.find((product) => product._id === addProductId) || tracked[0];
  const riskBatches = data.batches.filter((batch) => Number(batch.projectedAtRisk || 0) > 0 && batch.quantity > 0).sort((left, right) => Number(right.projectedAtRisk || 0) - Number(left.projectedAtRisk || 0) || String(left.expiryDate).localeCompare(String(right.expiryDate)));
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.batches.filter((batch) => (status === "ALL" || batch.status === status)
      && (!needle || `${batch.productName} ${batch.sku} ${batch.lotNo} ${batch.locationCode} ${batch.locationName} ${batch.supplierName || ""}`.toLowerCase().includes(needle)));
  }, [data.batches, query, status]);

  function beginActivation(product: Product) {
    setActivating(product);
    setOpeningLots(Object.fromEntries(product.locationBalances.filter((balance) => balance.quantity > 0).map((balance) => [balance.locationId, { lotNo: "", expiryDate: "" }])));
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activating) return;
    const form = new FormData(event.currentTarget);
    const openings = activating.locationBalances.filter((balance) => balance.quantity > 0).map((balance) => ({
      locationId: balance.locationId,
      lotNo: openingLots[balance.locationId]?.lotNo || "",
      expiryDate: openingLots[balance.locationId]?.expiryDate || "",
      quantity: balance.quantity,
    }));
    setBusy(true);
    try {
      await apiRequest("/api/inventory-batches", { method: "POST", body: JSON.stringify({ action: "ACTIVATE", clientRequestId: crypto.randomUUID(), productId: activating._id, expiryWarningDays: form.get("expiryWarningDays"), openings }) });
      show(`${activating.name} now uses batch and expiry tracking.`);
      setActivating(null);
      await load(false);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not enable batch tracking.", "error"); }
    finally { setBusy(false); }
  }

  async function addBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAddProduct) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest("/api/inventory-batches", { method: "POST", body: JSON.stringify({
        action: "ADD", clientRequestId: crypto.randomUUID(), productId: selectedAddProduct._id,
        locationId: form.get("locationId"), lotNo: form.get("lotNo"), expiryDate: form.get("expiryDate"), quantity: form.get("quantity"), reason: form.get("reason"),
      }) });
      show("Batch stock added with an auditable inventory movement.");
      setAddOpen(false);
      await load(false);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not add batch stock.", "error"); }
    finally { setBusy(false); }
  }

  async function countBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!counting) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest("/api/inventory-batches", { method: "POST", body: JSON.stringify({ action: "COUNT", clientRequestId: crypto.randomUUID(), batchId: counting._id, version: counting.version, countedQuantity: form.get("countedQuantity"), reason: form.get("reason") }) });
      show("Physical batch count posted to the batch, location and company totals.");
      setCounting(null);
      await load(false);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not post the batch count.", "error"); }
    finally { setBusy(false); }
  }

  async function openTrace(lotNo: string, productId: string) {
    setTraceLoading(true);
    try { setTrace(await apiRequest<TraceData>(`/api/inventory-batches?lot=${encodeURIComponent(lotNo)}&productId=${encodeURIComponent(productId)}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not trace this lot.", "error"); }
    finally { setTraceLoading(false); }
  }

  async function disposeBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disposing) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await apiRequest<{ journalEntryNo?: string }>("/api/inventory-batches", { method: "POST", body: JSON.stringify({
        action: "DISPOSE", clientRequestId: crypto.randomUUID(), batchId: disposing._id, version: disposing.version,
        quantity: form.get("quantity"), disposition: form.get("disposition"), reason: form.get("reason"),
      }) });
      show(result.journalEntryNo ? `Batch disposal posted with inventory journal ${result.journalEntryNo}.` : "Batch disposal posted with stock evidence; the zero-cost batch required no monetary journal.");
      setDisposing(null);
      await load(false);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not post the batch disposal.", "error"); }
    finally { setBusy(false); }
  }

  return <div className="page page-enter batch-page">
    <PageHeader eyebrow="LOT TRACEABILITY" title="Batch & expiry control" description="Trace supplier lots from receipt to sale, issue oldest-expiring stock first and isolate expired inventory." action={canWrite ? <div className="page-actions"><button className="button button-secondary" disabled={!tracked.length} onClick={() => { setAddProductId(tracked[0]?._id || ""); setAddOpen(true); }}><PackagePlus size={17} />Add discovered batch</button></div> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row">
      <article><ShieldCheck /><span>Tracked products</span><strong>{data.counts.trackedProducts}</strong></article>
      <article className={data.counts.atRiskUnits ? "warn" : ""}><TrendingDown /><span>Projected at risk</span><strong>{data.counts.atRiskUnits}</strong></article>
      <article className={data.counts.expired ? "warn" : ""}><AlertTriangle /><span>Expired batches</span><strong>{data.counts.expired}</strong></article>
    </section>

    {canWrite && eligible.length ? <section className="panel batch-activation-panel">
      <div className="panel-header"><div><span className="eyebrow">GRADUAL ACTIVATION</span><h2>Products ready for batch tracking</h2></div><span className="panel-note">LOCATION INVENTORY REQUIRED</span></div>
      <div className="batch-ready-grid">{eligible.map((product) => <article key={product._id}><Boxes /><span><strong>{product.name}</strong><small>{product.sku} · {product.stock} {product.unit} across {product.locationBalances.length} locations</small></span><button className="button button-primary" onClick={() => beginActivation(product)}>Enable tracking</button></article>)}</div>
    </section> : null}

    {!loading && riskBatches.length ? <section className="panel freshness-panel"><div className="panel-header"><div><span className="eyebrow">30-DAY DEMAND FORECAST</span><h2>Freshness action queue</h2></div><span className="panel-note">ADVISORY · NOT AN AUTO-MOVEMENT</span></div><div className="freshness-grid">{riskBatches.slice(0, 8).map((batch) => <article key={`risk-${batch._id}`}><span><StatusPill value={batch.forecastRisk || "MEDIUM"} /><strong>{batch.productName} · {batch.lotNo}</strong><small>{batch.locationCode} · {batch.projectedAtRisk} of {batch.quantity} units may remain at expiry · {batch.dailyDemand || 0}/day</small></span>{batch.transferSuggestion ? <Link className="button button-secondary" href="/transfers"><ArrowLeftRight size={14} />Move up to {batch.transferSuggestion.quantity} to {batch.transferSuggestion.locationCode}</Link> : batch.status === "EXPIRED" && canWrite ? <button className="button button-secondary" onClick={() => setDisposing(batch)}><Trash2 size={14} />Write off</button> : <small>{batch.predictedDepletionDate ? `Projected depletion ${batch.predictedDepletionDate}` : "No recent demand"}</small>}</article>)}</div></section> : null}

    <section className="panel resource-panel batch-ledger">
      <div className="resource-toolbar"><label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search product, lot, supplier or location" /></label><div className="archive-toggle">{["ALL", "EXPIRING", "EXPIRED", "HEALTHY", "DEPLETED"].map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{value === "ALL" ? "All" : value.toLowerCase()}</button>)}</div></div>
      {loading ? <LoadingPanel label="Reading batch inventory…" /> : filtered.length ? <div className="data-list batch-list"><div className="data-list-head"><span>Product / lot</span><span>Location</span><span>Expiry</span><span>On hand</span><span>Origin</span><span>Action</span></div>{filtered.map((batch) => <div className={`data-row batch-${batch.status.toLowerCase()}`} key={batch._id}><div><strong>{batch.productName}</strong><small>{batch.sku} · LOT {batch.lotNo}</small></div><div><strong>{batch.locationCode}</strong><small>{batch.locationName}</small></div><div><StatusPill value={batch.status} /><small>{batch.status === "DEPLETED" ? `Depleted · ${batch.expiryDate}` : batch.status === "EXPIRED" ? `${Math.abs(batch.daysRemaining || 0)} days overdue · ${batch.expiryDate}` : `${batch.daysRemaining} days remaining · ${batch.expiryDate}`}</small></div><div><strong>{batch.quantity}</strong><small>{batch.projectedAtRisk ? `${batch.projectedAtRisk} forecast at risk` : "physical units"}</small></div><div><strong>{batch.supplierName || "Opening / adjustment"}</strong><small>{batch.goodsReceiptNo || "Controlled record"}</small></div><div className="row-actions"><button className="button button-quiet" disabled={traceLoading} onClick={() => void openTrace(batch.lotNo, batch.productId)}>Trace</button>{canWrite ? <><button className="button button-secondary" onClick={() => setCounting(batch)}><ClipboardCheck size={15} />Count</button>{batch.quantity > 0 ? <button className="icon-button danger" title="Dispose and write off batch stock" onClick={() => setDisposing(batch)}><Trash2 size={15} /></button> : null}</> : null}</div></div>)}</div> : <EmptyState title="No batches in this view" detail={tracked.length ? "Change the filter, or receive and record the next supplier lot." : "Enable batch tracking for a location-tracked product to begin."} />}
    </section>

    <Modal open={Boolean(activating)} onClose={() => setActivating(null)} title={`Enable ${activating?.name || "batch tracking"}`} kicker="OPENING LOTS">
      <form className="modal-form wide-form" onSubmit={activate}><div className="receipt-control-note"><AlertTriangle /><span><strong>This control is permanent for the product</strong><small>Opening lots must reconcile exactly to every location balance. Future purchasing, sales, refunds and transfers will move batch stock automatically.</small></span></div><label className="field"><span>Expiry warning window</span><input name="expiryWarningDays" type="number" min="1" max="365" defaultValue="30" required /></label><div className="batch-opening-list">{activating?.locationBalances.filter((balance) => balance.quantity > 0).map((balance) => <div key={balance.locationId}><span><strong>{balance.locationCode} · {balance.locationName}</strong><small>{balance.quantity} {activating.unit} opening stock</small></span><input aria-label={`${balance.locationName} lot number`} placeholder="Lot number" required value={openingLots[balance.locationId]?.lotNo || ""} onChange={(event) => setOpeningLots((current) => ({ ...current, [balance.locationId]: { lotNo: event.target.value, expiryDate: current[balance.locationId]?.expiryDate || "" } }))} /><input aria-label={`${balance.locationName} expiry date`} type="date" required value={openingLots[balance.locationId]?.expiryDate || ""} onChange={(event) => setOpeningLots((current) => ({ ...current, [balance.locationId]: { lotNo: current[balance.locationId]?.lotNo || "", expiryDate: event.target.value } }))} /></div>)}</div>{activating && !activating.stock ? <p className="form-hint">This product has no opening stock. Tracking will begin with its next receipt or controlled batch addition.</p> : null}<footer><button type="button" className="button button-secondary" onClick={() => setActivating(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Enabling…" : "Reconcile & enable"}</button></footer></form>
    </Modal>

    <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add discovered batch" kicker="CONTROLLED INCREASE">
      <form className="modal-form" onSubmit={addBatch}><p className="form-hint">Use this only for physical stock not yet recorded. Normal supplier deliveries belong in Purchasing.</p><label className="field"><span>Product</span><select value={selectedAddProduct?._id || ""} onChange={(event) => setAddProductId(event.target.value)} required>{tracked.map((product) => <option key={product._id} value={product._id}>{product.sku} · {product.name}</option>)}</select></label><label className="field"><span>Location</span><select name="locationId" required>{data.locations.map((location) => <option key={location._id} value={location._id}>{location.code} · {location.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>Lot number</span><input name="lotNo" maxLength={80} required /></label><label className="field"><span>Expiry date</span><input name="expiryDate" type="date" required /></label></div><label className="field"><span>Quantity</span><input name="quantity" type="number" min="1" step="1" required /></label><label className="field"><span>Reason</span><input name="reason" minLength={3} maxLength={200} placeholder="Found during shelf count, opening correction…" required /></label><footer><button type="button" className="button button-secondary" onClick={() => setAddOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Posting…" : "Post batch stock"}</button></footer></form>
    </Modal>

    <Modal open={Boolean(counting)} onClose={() => setCounting(null)} title={`Count lot ${counting?.lotNo || ""}`} kicker="PHYSICAL BATCH COUNT">
      <form className="modal-form" onSubmit={countBatch}><p className="form-hint">Book quantity: <strong>{counting?.quantity || 0}</strong> at {counting?.locationCode}. A variance updates the batch, location and company totals together.</p><label className="field"><span>Physical quantity</span><input name="countedQuantity" type="number" min="0" step="1" defaultValue={counting?.quantity} required autoFocus /></label><label className="field"><span>Count reason</span><input name="reason" minLength={3} maxLength={200} placeholder="Weekly expiry count, damaged stock…" required /></label><footer><button type="button" className="button button-secondary" onClick={() => setCounting(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Posting…" : "Post count"}</button></footer></form>
    </Modal>

    <Modal open={Boolean(disposing)} onClose={() => setDisposing(null)} title={`Write off lot ${disposing?.lotNo || ""}`} kicker="IRREVERSIBLE DISPOSITION">
      <form className="modal-form" onSubmit={disposeBatch}><div className="refund-warning"><Trash2 size={18} /><p>This permanently removes physical stock and posts Inventory write-off against the Inventory asset at the product's current weighted cost. Use Count instead when the book quantity itself is wrong.</p></div><p className="form-hint">Available: <strong>{disposing?.quantity || 0}</strong> units at {disposing?.locationCode} · expiry {disposing?.expiryDate}</p><label className="field"><span>Quantity to dispose</span><input name="quantity" type="number" min="1" max={disposing?.quantity || 1} step="1" defaultValue={disposing?.status === "EXPIRED" ? disposing.quantity : 1} required autoFocus /></label><label className="field"><span>Disposition</span><select name="disposition" defaultValue={disposing?.status === "EXPIRED" ? "EXPIRED" : "QUALITY"} required><option value="EXPIRED">Expired</option><option value="DAMAGED">Damaged</option><option value="QUALITY">Quality failure</option><option value="RECALL">Recall disposal</option><option value="OTHER">Other</option></select></label><label className="field"><span>Evidence note</span><textarea name="reason" rows={3} minLength={3} maxLength={240} placeholder="Why the stock cannot be sold or returned…" required /></label><footer><button type="button" className="button button-secondary" onClick={() => setDisposing(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Posting write-off…" : "Dispose & post journal"}</button></footer></form>
    </Modal>

    <Modal open={Boolean(trace)} onClose={() => setTrace(null)} title={`Trace lot ${trace?.lotNo || ""}`} kicker="SUPPLIER TO CUSTOMER">
      <div className="batch-trace"><div className="receipt-control-note"><ShieldCheck /><span><strong>Immutable movement evidence</strong><small>This view follows the normalized lot across receipts, sales, refunds, adjustments, disposals and location transfers. It does not claim a supplier or regulator recall decision.</small></span></div>{([ ["Goods receipts", trace?.receipts || []], ["Sales", trace?.sales || []], ["Refunds", trace?.refunds || []], ["Transfers", trace?.transfers || []] ] as Array<[string, TraceRecord[]]>).map(([label, records]) => <section key={label}><header><strong>{label}</strong><span>{records.length}</span></header>{records.length ? records.map((record) => <article key={record._id}><span><strong>{record.receiptNo || record.refundNo || record.transferNo}</strong><small>{record.purchaseOrderNo || record.supplierName || record.status || "Posted record"}</small></span><span>{record.sourceLocationCode && record.destinationLocationCode ? `${record.sourceLocationCode} → ${record.destinationLocationCode}` : record.locationCode || "—"}</span><b>{record.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)} units</b></article>) : <small>No matching records</small>}</section>)}<section><header><strong>Controlled adjustments & disposal</strong><span>{trace?.events.length || 0}</span></header>{trace?.events.length ? trace.events.map((event) => <article key={event._id}><span><strong>{event.eventNo}</strong><small>{event.action}{event.disposition ? ` · ${event.disposition}` : ""} · {event.reason}</small></span><span>{event.locationCode || "—"}</span><b>{event.quantity > 0 ? "+" : ""}{event.quantity} units</b></article>) : <small>No matching records</small>}</section></div>
    </Modal>
  </div>;
}
