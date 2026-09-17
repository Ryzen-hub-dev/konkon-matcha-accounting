"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeftRight, Boxes, CheckCircle2, MapPin, PackageCheck, Search, Truck, Undo2, Warehouse } from "lucide-react";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import type { StockTransferRecord } from "@/lib/inventory-locations";
import type { LocationRecord } from "@/lib/locations";
import type { ProductRecord } from "@/lib/types";

type TransferProduct = ProductRecord & { allocatedStock: number };
type TransferData = { locations: LocationRecord[]; products: TransferProduct[]; transfers: StockTransferRecord[] };

export function StockTransfersView({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<TransferData>({ locations: [], products: [], transfers: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [allocationProduct, setAllocationProduct] = useState<TransferProduct | null>(null);
  const [allocationRequestId, setAllocationRequestId] = useState("");
  const [allocationValues, setAllocationValues] = useState<Record<string, string>>({});
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [transferRequestId, setTransferRequestId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [transferValues, setTransferValues] = useState<Record<string, string>>({});
  const [actionTransfer, setActionTransfer] = useState<StockTransferRecord | null>(null);
  const [action, setAction] = useState<"RECEIVE" | "CANCEL">("RECEIVE");
  const [completionNote, setCompletionNote] = useState("");
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try { setData(await apiRequest<TransferData>("/api/stock-transfers")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load location inventory.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const tracked = data.products.filter((product) => product.locationTracked);
  const unallocated = data.products.filter((product) => !product.locationTracked);
  const inTransit = data.transfers.filter((transfer) => transfer.status === "IN_TRANSIT");
  const sourceProducts = tracked.filter((product) => Number(product.locationBalances?.find((balance) => balance.locationId === sourceId)?.quantity || 0) > 0);
  const filteredTransfers = data.transfers.filter((transfer) => `${transfer.transferNo} ${transfer.sourceLocationName} ${transfer.destinationLocationName} ${transfer.items.map((item) => `${item.sku} ${item.productName}`).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const locationTotals = useMemo(() => data.locations.map((location) => {
    const balances = tracked.flatMap((product) => (product.locationBalances || []).filter((balance) => balance.locationId === location._id).map((balance) => ({ ...balance, unit: product.unit })));
    return { location, balances, units: balances.reduce((sum, balance) => sum + Number(balance.quantity || 0), 0), skus: balances.filter((balance) => balance.quantity > 0).length };
  }), [data.locations, data.products]);

  function openAllocation(product: TransferProduct) {
    const values = Object.fromEntries(data.locations.map((location) => [location._id, "0"]));
    const preferred = data.locations.find((location) => location.type === "HEADQUARTERS") || data.locations[0];
    if (preferred) values[preferred._id] = String(product.stock);
    setAllocationValues(values);
    setAllocationRequestId(crypto.randomUUID());
    setAllocationProduct(product);
  }

  async function allocate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allocationProduct || busy) return;
    setBusy(true);
    try {
      await apiRequest("/api/stock-transfers", { method: "POST", body: JSON.stringify({ action: "ALLOCATE", clientRequestId: allocationRequestId, productId: allocationProduct._id, allocations: data.locations.map((location) => ({ locationId: location._id, quantity: allocationValues[location._id] || 0 })) }) });
      show(`${allocationProduct.name} now uses location inventory.`);
      setAllocationProduct(null);
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not activate location inventory.", "error"); }
    finally { setBusy(false); }
  }

  function openDispatch() {
    const source = data.locations[0]?._id || "";
    setSourceId(source);
    setDestinationId(data.locations.find((location) => location._id !== source)?._id || "");
    setTransferValues({});
    setTransferRequestId(crypto.randomUUID());
    setDispatchOpen(true);
  }

  async function dispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const items = Object.entries(transferValues).filter(([, quantity]) => Number(quantity) > 0).map(([productId, quantity]) => ({ productId, quantity }));
    if (!items.length) return show("Enter at least one transfer quantity.", "error");
    setBusy(true);
    try {
      const transfer = await apiRequest<StockTransferRecord>("/api/stock-transfers", { method: "POST", body: JSON.stringify({ action: "DISPATCH", clientRequestId: transferRequestId, sourceLocationId: sourceId, destinationLocationId: destinationId, note: form.get("note"), items }) });
      show(`${transfer.transferNo} dispatched and is now in transit.`);
      setDispatchOpen(false);
      setTransferValues({});
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not dispatch the transfer.", "error"); }
    finally { setBusy(false); }
  }

  async function completeAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!actionTransfer || busy) return;
    setBusy(true);
    try {
      await apiRequest("/api/stock-transfers", { method: "PATCH", body: JSON.stringify({ id: actionTransfer._id, version: actionTransfer.version, action, note: completionNote }) });
      show(action === "RECEIVE" ? `${actionTransfer.transferNo} received into destination stock.` : `${actionTransfer.transferNo} cancelled and returned to source stock.`);
      setActionTransfer(null);
      setCompletionNote("");
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not update the transfer.", "error"); }
    finally { setBusy(false); }
  }

  const allocationEntered = Object.values(allocationValues).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return <div className="page page-enter transfer-page">
    <PageHeader eyebrow="LOCATION INVENTORY" title="Stock transfers" description="Allocate legacy stock once, dispatch between locations, and keep in-transit quantities separate until receipt." action={canWrite && tracked.length && data.locations.length > 1 ? <AddButton onClick={openDispatch}>New transfer</AddButton> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><Warehouse /><span>Active locations</span><strong>{data.locations.length}</strong></article><article><Boxes /><span>Location-tracked SKUs</span><strong>{tracked.length}</strong></article><article className={inTransit.length ? "warn" : ""}><Truck /><span>In transit</span><strong>{inTransit.reduce((sum, transfer) => sum + transfer.totalUnits, 0)}</strong></article></section>
    <section className="transfer-control-note panel"><AlertTriangle /><div><strong>Company total stays unchanged during a transfer</strong><p>Dispatch removes units from the source location. Receipt adds them to the destination. Cancellation returns them to the source. No sale, purchase or accounting journal is created.</p></div></section>
    {loading ? <LoadingPanel label="Mapping stock across locations…" /> : <>
      <section className="location-stock-grid">{locationTotals.map(({ location, units, skus, balances }) => <article className="panel" key={location._id}><header><MapPin /><span><small>{location.code} · {location.type.replaceAll("_", " ")}</small><strong>{location.name}</strong></span></header><div><span><b>{units}</b> units</span><span><b>{skus}</b> stocked SKUs</span></div><footer>{balances.filter((balance) => balance.quantity > 0).slice(0, 4).map((balance) => <span key={balance.productId}>{balance.sku}<b>{balance.quantity} {balance.unit}</b></span>)}{!balances.some((balance) => balance.quantity > 0) ? <small>No on-hand stock</small> : null}</footer></article>)}</section>
      {unallocated.length ? <section className="panel allocation-panel"><header className="panel-header"><div><span className="eyebrow">ONE-TIME MIGRATION</span><h2>Allocate existing global stock</h2></div><strong>{unallocated.length} SKUs</strong></header><p>Before a product can move between locations, assign its current company total across active locations. The required total cannot change during this step.</p><div className="allocation-list">{unallocated.map((product) => <article key={product._id}><span><strong>{product.name}</strong><small>{product.sku} · {product.category}</small></span><b>{product.stock} {product.unit}</b>{canWrite ? <button className="button button-secondary" onClick={() => openAllocation(product)}>Allocate</button> : <StatusPill value="NOT ALLOCATED" />}</article>)}</div></section> : null}
      <section className="panel transfer-ledger"><div className="resource-toolbar"><label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transfer, location or product" /></label><span>{filteredTransfers.length} transfer records</span></div>{filteredTransfers.length ? <div className="transfer-list">{filteredTransfers.map((transfer) => <article key={transfer._id} className={transfer.status.toLowerCase()}><header><span><small>{transfer.transferNo}</small><strong>{transfer.sourceLocationCode} <ArrowLeftRight /> {transfer.destinationLocationCode}</strong></span><StatusPill value={transfer.status} /></header><p>{transfer.sourceLocationName} → {transfer.destinationLocationName}</p><div>{transfer.items.map((item) => <span key={item.productId}><b>{item.quantity} {item.unit}</b>{item.productName}<small>{item.sku}</small></span>)}</div><footer><span>{transfer.totalUnits} units · dispatched by {transfer.dispatchedByName}</span>{canWrite && transfer.status === "IN_TRANSIT" ? <div><button className="button button-secondary" onClick={() => { setAction("CANCEL"); setActionTransfer(transfer); setCompletionNote(""); }}><Undo2 size={14} />Cancel</button><button className="button button-primary" onClick={() => { setAction("RECEIVE"); setActionTransfer(transfer); setCompletionNote(""); }}><PackageCheck size={14} />Receive</button></div> : transfer.status === "RECEIVED" ? <span><CheckCircle2 size={13} />Received by {transfer.receivedByName}</span> : null}</footer></article>)}</div> : <EmptyState title="No stock transfers" detail="Allocate a product to locations, then dispatch the first controlled transfer." />}</section>
    </>}
    <Modal open={Boolean(allocationProduct)} onClose={() => { if (!busy) setAllocationProduct(null); }} title={`Allocate ${allocationProduct?.name || "stock"}`} kicker="ONE-TIME LOCATION OPENING"><form className="modal-form" onSubmit={allocate}><p className="form-hint">Distribute exactly <strong>{allocationProduct?.stock || 0} {allocationProduct?.unit}</strong>. Enter zero for locations with no opening stock.</p><div className="allocation-fields">{data.locations.map((location) => <label className="field" key={location._id}><span>{location.code} · {location.name}</span><input type="number" min="0" step="1" value={allocationValues[location._id] || "0"} onChange={(event) => setAllocationValues((current) => ({ ...current, [location._id]: event.target.value }))} /></label>)}</div><div className={`allocation-proof ${allocationEntered === Number(allocationProduct?.stock || 0) ? "balanced" : ""}`}><span>Entered</span><strong>{allocationEntered} / {allocationProduct?.stock || 0}</strong></div><footer><button type="button" className="button button-secondary" disabled={busy} onClick={() => setAllocationProduct(null)}>Cancel</button><button className="button button-primary" disabled={busy || allocationEntered !== Number(allocationProduct?.stock || 0)}>{busy ? "Activating…" : "Activate location stock"}</button></footer></form></Modal>
    <Modal open={dispatchOpen} onClose={() => { if (!busy) setDispatchOpen(false); }} title="Dispatch stock transfer" kicker="SOURCE TO DESTINATION"><form className="modal-form wide-form" onSubmit={dispatch}><div className="form-grid two"><label className="field"><span>Source</span><select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setTransferValues({}); }} required>{data.locations.map((location) => <option key={location._id} value={location._id}>{location.code} · {location.name}</option>)}</select></label><label className="field"><span>Destination</span><select value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required>{data.locations.filter((location) => location._id !== sourceId).map((location) => <option key={location._id} value={location._id}>{location.code} · {location.name}</option>)}</select></label></div><div className="transfer-product-lines">{sourceProducts.map((product) => { const available = Number(product.locationBalances?.find((balance) => balance.locationId === sourceId)?.quantity || 0); return <label key={product._id}><span><strong>{product.name}</strong><small>{product.sku} · {available} {product.unit} available</small></span><input aria-label={`${product.name} transfer quantity`} type="number" min="0" max={available} step="1" value={transferValues[product._id] || ""} onChange={(event) => setTransferValues((current) => ({ ...current, [product._id]: event.target.value }))} placeholder="0" /></label>; })}{!sourceProducts.length ? <EmptyState title="No stock at this source" detail="Choose another source or allocate inventory first." /> : null}</div><label className="field"><span>Dispatch note · optional</span><input name="note" maxLength={300} placeholder="Restock branch, event inventory…" /></label><footer><button type="button" className="button button-secondary" disabled={busy} onClick={() => setDispatchOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy || !sourceProducts.length || !destinationId}><Truck size={15} />{busy ? "Dispatching…" : "Dispatch transfer"}</button></footer></form></Modal>
    <Modal open={Boolean(actionTransfer)} onClose={() => { if (!busy) setActionTransfer(null); }} title={action === "RECEIVE" ? "Receive stock transfer" : "Cancel stock transfer"} kicker={actionTransfer?.transferNo || "TRANSFER"}><form className="modal-form" onSubmit={completeAction}><p className="form-hint">{action === "RECEIVE" ? `Confirm the physical stock arrived at ${actionTransfer?.destinationLocationName}. All lines will enter destination stock together.` : `All in-transit units will return to ${actionTransfer?.sourceLocationName}.`}</p><label className="field"><span>{action === "RECEIVE" ? "Receipt" : "Cancellation"} note {action === "CANCEL" ? "· required" : "· optional"}</span><textarea value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} required={action === "CANCEL"} minLength={action === "CANCEL" ? 3 : undefined} maxLength={300} /></label><footer><button type="button" className="button button-secondary" disabled={busy} onClick={() => setActionTransfer(null)}>Back</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : action === "RECEIVE" ? "Confirm receipt" : "Cancel and return stock"}</button></footer></form></Modal>
  </div>;
}
