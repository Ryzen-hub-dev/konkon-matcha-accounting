"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, Barcode, Boxes, CircleDollarSign, PackagePlus, Pencil, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, money, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import type { ProductRecord } from "@/lib/types";

export function InventoryView({ canWrite = false }: { canWrite?: boolean }) {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRecord | null>(null);
  const [adjusting, setAdjusting] = useState<ProductRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try { setProducts(await apiRequest<ProductRecord[]>(`/api/products${canWrite ? "?includeArchived=1" : ""}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load inventory.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const visible = products.filter((product) => showArchived ? !product.active : product.active !== false);
  const filtered = useMemo(() => visible.filter((product) => `${product.name} ${product.sku} ${product.barcode || ""} ${product.category}`.toLowerCase().includes(search.toLowerCase())), [visible, search]);
  const active = products.filter((product) => product.active !== false);
  const low = active.filter((product) => product.stock <= product.reorderLevel).length;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try { await apiRequest("/api/products", { method: "POST", body: JSON.stringify(data) }); show("Product added to inventory."); setAddOpen(false); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not add product.", "error"); }
    finally { setBusy(false); }
  }
  async function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return; setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try { await apiRequest("/api/products", { method: "PATCH", body: JSON.stringify({ id: editing._id, ...data }) }); show("Product details updated."); setEditing(null); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not update the product.", "error"); }
    finally { setBusy(false); }
  }
  async function adjust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!adjusting) return; setBusy(true);
    const data = new FormData(event.currentTarget);
    try { await apiRequest("/api/products", { method: "PATCH", body: JSON.stringify({ id: adjusting._id, adjustment: data.get("adjustment"), reason: data.get("reason") }) }); show("Stock movement posted."); setAdjusting(null); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not adjust stock.", "error"); }
    finally { setBusy(false); }
  }
  async function archive(product: ProductRecord) {
    if (!window.confirm(`Archive ${product.name}? Its ${product.stock} units and transaction history will be preserved.`)) return;
    try { await apiRequest("/api/products", { method: "DELETE", body: JSON.stringify({ id: product._id }) }); show("Product archived; historical records were preserved."); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not archive the product.", "error"); }
  }
  async function restore(product: ProductRecord) {
    try { await apiRequest("/api/products", { method: "PATCH", body: JSON.stringify({ id: product._id, restore: true }) }); show("Product restored to the shelf."); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not restore the product.", "error"); }
  }

  const productForm = (mode: "add" | "edit") => {
    const product = mode === "edit" ? editing : null;
    return <form className="modal-form" onSubmit={mode === "add" ? add : edit} key={product?._id || "new"}>
      <div className="barcode-entry"><Barcode /><label className="field"><span>Product barcode · scan or type · optional</span><input name="barcode" defaultValue={product?.barcode || ""} autoComplete="off" autoFocus placeholder="Focus here, then scan" /></label><small>USB/Bluetooth scanners usually type the code and press Enter. Products without a manufacturer barcode can leave this blank.</small></div>
      <div className="form-grid two"><label className="field"><span>Product name</span><input name="name" defaultValue={product?.name} required /></label><label className="field"><span>SKU</span><input name="sku" defaultValue={product?.sku} pattern="[A-Za-z0-9._-]+" required /></label></div>
      <div className="form-grid two"><label className="field"><span>Category</span><input name="category" defaultValue={product?.category} placeholder="Matcha powder" required /></label><label className="field"><span>Unit</span><input name="unit" defaultValue={product?.unit} placeholder="tin" required /></label></div>
      <div className={`form-grid ${mode === "add" ? "four" : "three"}`}><label className="field"><span>Retail</span><input name="price" type="number" min="0" step="0.01" defaultValue={product?.price} required /></label><label className="field"><span>Cost</span><input name="cost" type="number" min="0" step="0.01" defaultValue={product?.cost} required /></label>{mode === "add" ? <label className="field"><span>Opening stock</span><input name="stock" type="number" min="0" step="1" required /></label> : null}<label className="field"><span>Reorder at</span><input name="reorderLevel" type="number" min="0" step="1" defaultValue={product?.reorderLevel} required /></label></div>
      <footer><button type="button" className="button button-secondary" onClick={() => mode === "add" ? setAddOpen(false) : setEditing(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : mode === "add" ? "Add product" : "Save product"}</button></footer>
    </form>;
  };

  return <div className="page page-enter">
    <PageHeader eyebrow="TEA STORE" title="Inventory" description="Edit the catalogue, capture barcodes and preserve every stock movement." action={canWrite ? <AddButton onClick={() => setAddOpen(true)}>New product</AddButton> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><Boxes /><span>Units on hand</span><strong>{active.reduce((sum, product) => sum + product.stock, 0).toLocaleString()}</strong></article><article><CircleDollarSign /><span>Stock at cost</span><strong>{money.format(active.reduce((sum, product) => sum + product.cost * product.stock, 0))}</strong></article><article className={low ? "warn" : ""}><AlertTriangle /><span>At or below reorder</span><strong>{low}</strong></article></section>
    <section className="panel resource-panel"><div className="resource-toolbar"><label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product, barcode, category or SKU" /></label>{canWrite ? <div className="archive-toggle"><button className={!showArchived ? "active" : ""} onClick={() => setShowArchived(false)}>Active</button><button className={showArchived ? "active" : ""} onClick={() => setShowArchived(true)}>Archived</button></div> : <span>{filtered.length} active SKUs</span>}</div>
      {loading ? <LoadingPanel /> : filtered.length ? <div className="data-list inventory-list"><div className="data-list-head"><span>Product</span><span>Category</span><span>On hand</span><span>Retail / cost</span><span>Barcode</span><span>Actions</span></div>{filtered.map((product) => <div className={`data-row ${!product.active ? "is-archived" : ""}`} key={product._id}><div className="product-cell"><i>{product.name.toLowerCase().includes("hojicha") ? "焙" : "抹"}</i><div><strong>{product.name}</strong><small>{product.sku}</small></div></div><span>{product.category}</span><div><strong>{product.stock} {product.unit}</strong>{product.active && product.stock <= product.reorderLevel ? <small className="low-label">Reorder at {product.reorderLevel}</small> : <small>{product.active ? "Healthy" : "Preserved"}</small>}</div><div><strong>{money.format(product.price)}</strong><small>{money.format(product.cost)} cost</small></div><div><strong className="barcode-value">{product.barcode || "NO BARCODE"}</strong><small><StatusPill value={product.active ? "ACTIVE" : "ARCHIVED"} /></small></div>{canWrite ? <div className="row-actions">{product.active ? <><button className="icon-button" title="Edit product" onClick={() => setEditing(product)}><Pencil size={15} /></button><button className="icon-button" title="Adjust stock" onClick={() => setAdjusting(product)}><SlidersHorizontal size={15} /></button><button className="icon-button danger" title="Archive product" onClick={() => archive(product)}><Archive size={15} /></button></> : <button className="button button-secondary" onClick={() => restore(product)}><RotateCcw size={15} />Restore</button>}</div> : <span />}</div>)}</div> : <EmptyState title={showArchived ? "No archived products" : "The shelf is empty"} detail={showArchived ? "Archived catalogue items will remain available for audit here." : "Add the first product to begin tracking stock."} action={!showArchived && canWrite ? <AddButton onClick={() => setAddOpen(true)}>New product</AddButton> : undefined} />}
    </section>
    <Modal open={addOpen} onClose={() => setAddOpen(false)} title="New product" kicker="SCAN OR ADD"><>{productForm("add")}</></Modal>
    <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name || "product"}`} kicker="CATALOGUE"><>{productForm("edit")}</></Modal>
    <Modal open={Boolean(adjusting)} onClose={() => setAdjusting(null)} title={`Adjust ${adjusting?.name || "stock"}`} kicker="STOCK MOVEMENT"><form className="modal-form" onSubmit={adjust}><p className="form-hint">Current balance: <strong>{adjusting?.stock} {adjusting?.unit}</strong>. Use a negative number for wastage or a positive number for received stock.</p><label className="field"><span>Quantity change</span><input name="adjustment" type="number" step="1" placeholder="e.g. 12 or -2" required autoFocus /></label><label className="field"><span>Reason</span><input name="reason" placeholder="Supplier delivery, damaged tin…" required /></label><footer><button type="button" className="button button-secondary" onClick={() => setAdjusting(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Posting…" : "Post movement"}</button></footer></form></Modal>
  </div>;
}
