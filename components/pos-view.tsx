"use client";

import { useEffect, useMemo, useState } from "react";
import { Banknote, CheckCircle2, ChevronRight, CreditCard, Minus, Plus, Search, ShoppingBasket, Smartphone, Trash2, UserRound } from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, Modal, money, Notice, PageHeader, useNotice } from "@/components/ui";
import type { MemberRecord, ProductRecord } from "@/lib/types";

type CartLine = ProductRecord & { quantity: number };
type SaleReceipt = { receiptNo: string; total: number; memberName: string; paymentMethod: string; items: Array<{ name: string; quantity: number; lineTotal: number }> };

export function PosView() {
  const [products, setProducts] = useState<ProductRecord[]>([]); const [members, setMembers] = useState<MemberRecord[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]); const [search, setSearch] = useState(""); const [category, setCategory] = useState("All");
  const [memberId, setMemberId] = useState(""); const [payment, setPayment] = useState("PAYNOW"); const [discount, setDiscount] = useState(0);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const { notice, show } = useNotice();
  async function load() { setLoading(true); try { const [p, m] = await Promise.all([apiRequest<ProductRecord[]>("/api/products"), apiRequest<MemberRecord[]>("/api/members")]); setProducts(p); setMembers(m); } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load the register.", "error"); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);
  const categories = useMemo(() => ["All", ...new Set(products.map((product) => product.category))], [products]);
  const filtered = useMemo(() => products.filter((product) => (category === "All" || product.category === category) && `${product.name} ${product.sku}`.toLowerCase().includes(search.toLowerCase())), [products, category, search]);
  const subtotal = cart.reduce((sum, line) => sum + line.price * line.quantity, 0); const total = Math.max(0, subtotal - discount);
  function add(product: ProductRecord) { if (product.stock <= 0) return; setCart((current) => { const existing = current.find((line) => line._id === product._id); return existing ? current.map((line) => line._id === product._id ? { ...line, quantity: Math.min(product.stock, line.quantity + 1) } : line) : [...current, { ...product, quantity: 1 }]; }); }
  function quantity(id: string, delta: number) { setCart((current) => current.map((line) => line._id === id ? { ...line, quantity: Math.min(line.stock, Math.max(0, line.quantity + delta)) } : line).filter((line) => line.quantity > 0)); }
  async function checkout() {
    if (!cart.length || busy) return; setBusy(true);
    try { const result = await apiRequest<SaleReceipt>("/api/sales", { method: "POST", body: JSON.stringify({ memberId: memberId || null, paymentMethod: payment, discount, items: cart.map((line) => ({ productId: line._id, quantity: line.quantity })) }) }); setReceipt(result); setCart([]); setDiscount(0); setMemberId(""); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Sale could not be completed.", "error"); } finally { setBusy(false); }
  }
  return <div className="page page-enter pos-page">
    <PageHeader eyebrow="COUNTER" title="Point of sale" description="Ring up tea, reward members and post the books in one pour." />
    {notice ? <Notice {...notice} /> : null}
    {loading ? <LoadingPanel label="Opening the register…" /> : <div className="pos-layout">
      <section className="catalog-panel">
        <div className="catalog-toolbar"><label className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tea, dōgu or SKU" /></label><span>{filtered.length} items</span></div>
        <div className="category-tabs" role="tablist">{categories.map((name) => <button key={name} className={category === name ? "active" : ""} onClick={() => setCategory(name)}>{name}</button>)}</div>
        {filtered.length ? <div className="product-grid">{filtered.map((product) => <button className="product-card" key={product._id} onClick={() => add(product)} disabled={product.stock <= 0}>
          <div className="product-top"><span>{product.category}</span><i className={product.stock <= product.reorderLevel ? "low" : ""}>{product.stock ? `${product.stock} left` : "Sold out"}</i></div>
          <div className="product-glyph" aria-hidden="true"><span>{product.name.toLowerCase().includes("hojicha") ? "焙" : product.category === "Dōgu" ? "道" : "抹"}</span></div>
          <strong>{product.name}</strong><small>{product.sku}</small><footer><b>{money.format(product.price)}</b><span><Plus size={16} /></span></footer>
        </button>)}</div> : <EmptyState title="No tea found" detail="Try a different search or category." />}
      </section>
      <aside className="cart-panel">
        <header><div><span className="eyebrow light">CURRENT ORDER</span><h2>Tea tray <b>{cart.reduce((sum, line) => sum + line.quantity, 0)}</b></h2></div><ShoppingBasket /></header>
        <label className="member-select"><UserRound size={17} /><select value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">Walk-in guest</option>{members.map((member) => <option key={member._id} value={member._id}>{member.name} · {member.points} pts</option>)}</select><ChevronRight size={16} /></label>
        <div className="cart-lines">{cart.length ? cart.map((line) => <div className="cart-line" key={line._id}><div><strong>{line.name}</strong><span>{money.format(line.price)} each</span></div><div className="qty-control"><button onClick={() => quantity(line._id, -1)}>{line.quantity === 1 ? <Trash2 size={14} /> : <Minus size={14} />}</button><b>{line.quantity}</b><button onClick={() => quantity(line._id, 1)} disabled={line.quantity >= line.stock}><Plus size={14} /></button></div><strong>{money.format(line.price * line.quantity)}</strong></div>) : <EmptyState title="The tray is empty" detail="Choose a product to begin the order." />}</div>
        <div className="cart-totals"><label><span>Discount</span><div><span>$</span><input type="number" min="0" max={subtotal} step="0.01" value={discount} onChange={(event) => setDiscount(Math.max(0, Number(event.target.value)))} /></div></label><p><span>Subtotal</span><b>{money.format(subtotal)}</b></p><p><span>GST</span><b>Calculated at checkout</b></p><p className="grand-total"><span>Total</span><strong>{money.format(total)}</strong></p></div>
        <div className="payment-methods"><span>PAYMENT</span><div>{[{ id: "CASH", icon: Banknote }, { id: "CARD", icon: CreditCard }, { id: "PAYNOW", icon: Smartphone }].map(({ id, icon: Icon }) => <button key={id} className={payment === id ? "active" : ""} onClick={() => setPayment(id)}><Icon size={17} />{id}</button>)}</div></div>
        <button className="checkout-button" disabled={!cart.length || busy} onClick={checkout}><span>{busy ? "Posting sale…" : "Complete sale"}</span><strong>{money.format(total)}</strong><ChevronRight size={20} /></button>
      </aside>
    </div>}
    <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Sale complete" kicker="FRESHLY POSTED">{receipt ? <div className="receipt-modal"><CheckCircle2 size={42} /><p className="receipt-number">{receipt.receiptNo}</p><strong>{money.format(receipt.total)}</strong><span>{receipt.memberName} · {receipt.paymentMethod}</span><div>{receipt.items.map((item) => <p key={item.name}><span>{item.quantity} × {item.name}</span><b>{money.format(item.lineTotal)}</b></p>)}</div><div className="receipt-actions"><button className="button button-secondary" onClick={() => window.print()}>Print receipt</button><button className="button button-primary" onClick={() => setReceipt(null)}>Start next order</button></div></div> : null}</Modal>
  </div>;
}
