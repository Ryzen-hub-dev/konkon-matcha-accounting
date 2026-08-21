"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Banknote, ChevronRight, CreditCard, ExternalLink, Minus, Palette, Plus,
  ReceiptText, Search, ShoppingBasket, Smartphone, Trash2, UserRound,
} from "lucide-react";
import { ReceiptPaper, type ReceiptPaperDocument } from "@/components/receipt-paper";
import { ReceiptTemplateStudio } from "@/components/receipt-template-studio";
import { apiRequest, EmptyState, LoadingPanel, Modal, money, Notice, PageHeader, useNotice } from "@/components/ui";
import type { ReceiptTemplateRecord } from "@/lib/receipt-templates";
import { calculateTaxTotals } from "@/lib/tax";
import type { MemberRecord, ProductRecord } from "@/lib/types";

type CartLine = ProductRecord & { quantity: number };
type RegisterConfig = { currency: string; taxName: string; taxRate: number; taxMode: "EXCLUSIVE" | "INCLUSIVE" };
type TemplateConfig = { templates: ReceiptTemplateRecord[]; register: RegisterConfig };
type SaleReceipt = ReceiptPaperDocument & { _id: string; templateName?: string; templateSnapshot?: ReceiptTemplateRecord };

export function PosView({ canManageTemplates = false }: { canManageTemplates?: boolean }) {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [templates, setTemplates] = useState<ReceiptTemplateRecord[]>([]);
  const [register, setRegister] = useState<RegisterConfig>({ currency: "SGD", taxName: "GST", taxRate: 0, taxMode: "EXCLUSIVE" });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [memberId, setMemberId] = useState("");
  const [payment, setPayment] = useState("PAYNOW");
  const [discount, setDiscount] = useState(0);
  const [tenderedAmount, setTenderedAmount] = useState(0);
  const [paymentReference, setPaymentReference] = useState("");
  const [saleNote, setSaleNote] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const { notice, show } = useNotice();

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const [productData, memberData, templateData] = await Promise.all([
        apiRequest<ProductRecord[]>("/api/products"),
        apiRequest<MemberRecord[]>("/api/members"),
        apiRequest<TemplateConfig>("/api/receipt-templates"),
      ]);
      setProducts(productData);
      setMembers(memberData);
      setTemplates(templateData.templates);
      setRegister(templateData.register);
      setSelectedTemplateId((current) => current || (templateData.templates.find((template) => template.isDefault) || templateData.templates[0])?._id || "");
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load the register.", "error");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const categories = useMemo(() => ["All", ...new Set(products.map((product) => product.category))], [products]);
  const filtered = useMemo(() => products.filter((product) => (category === "All" || product.category === category) && `${product.name} ${product.sku}`.toLowerCase().includes(search.toLowerCase())), [products, category, search]);
  const { subtotal, tax, total } = calculateTaxTotals(cart.reduce((sum, line) => sum + line.price * line.quantity, 0), discount, register.taxRate, register.taxMode);
  const cashOptions = [...new Set([total, Math.ceil(total / 5) * 5, Math.ceil(total / 10) * 10, Math.ceil(total / 50) * 50])].filter((value) => value >= total);

  function add(product: ProductRecord) {
    if (product.stock <= 0) return;
    setCart((current) => {
      const existing = current.find((line) => line._id === product._id);
      return existing
        ? current.map((line) => line._id === product._id ? { ...line, quantity: Math.min(product.stock, line.quantity + 1) } : line)
        : [...current, { ...product, quantity: 1 }];
    });
  }

  function quantity(id: string, delta: number) {
    setCart((current) => current.map((line) => line._id === id ? { ...line, quantity: Math.min(line.stock, Math.max(0, line.quantity + delta)) } : line).filter((line) => line.quantity > 0));
  }

  function selectPayment(method: string) {
    setPayment(method);
    setPaymentReference("");
    if (method === "CASH") setTenderedAmount(total);
  }

  async function checkout() {
    if (!cart.length || busy || !selectedTemplateId) return;
    if (payment === "CASH" && tenderedAmount < total) return show("Enter enough cash to cover the amount due.", "error");
    setBusy(true);
    try {
      const result = await apiRequest<SaleReceipt>("/api/sales", {
        method: "POST",
        body: JSON.stringify({
          memberId: memberId || null,
          paymentMethod: payment,
          paymentReference,
          tenderedAmount: payment === "CASH" ? tenderedAmount : total,
          templateId: selectedTemplateId,
          saleNote,
          discount,
          items: cart.map((line) => ({ productId: line._id, quantity: line.quantity })),
        }),
      });
      setReceipt(result);
      setCart([]);
      setDiscount(0);
      setTenderedAmount(0);
      setPaymentReference("");
      setSaleNote("");
      setMemberId("");
      await load(false);
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Sale could not be completed.", "error");
    } finally {
      setBusy(false);
    }
  }

  return <div className="page page-enter pos-page">
    <PageHeader eyebrow="COUNTER" title="Point of sale" description="The amount on screen is the amount charged, posted and printed." action={<div className="pos-page-actions"><Link className="button button-secondary" href="/receipts"><ReceiptText size={17} />Receipt history</Link>{canManageTemplates ? <button className="button button-secondary" onClick={() => setStudioOpen(true)}><Palette size={17} />Receipt templates</button> : null}</div>} />
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

        <div className="cart-totals"><label><span>Discount</span><div><span>$</span><input type="number" min="0" max={subtotal} step="0.01" value={discount || ""} onChange={(event) => setDiscount(Math.min(subtotal, Math.max(0, Number(event.target.value))))} placeholder="0.00" /></div></label><p><span>Subtotal</span><b>{money.format(subtotal)}</b></p>{discount > 0 ? <p><span>Discount</span><b>−{money.format(discount)}</b></p> : null}<p><span>{register.taxName} · {register.taxRate}%{register.taxMode === "INCLUSIVE" ? " included" : ""}</span><b>{money.format(tax)}</b></p><p className="grand-total"><span>Amount due</span><strong>{money.format(total)}</strong></p></div>

        <div className="payment-methods"><span>PAYMENT</span><div>{[{ id: "CASH", icon: Banknote }, { id: "CARD", icon: CreditCard }, { id: "PAYNOW", icon: Smartphone }].map(({ id, icon: Icon }) => <button key={id} className={payment === id ? "active" : ""} onClick={() => selectPayment(id)}><Icon size={17} />{id}</button>)}</div></div>
        {payment === "CASH" ? <div className="cash-tender"><label><span>Cash received</span><input type="number" min={total} step="0.01" value={tenderedAmount || ""} onChange={(event) => setTenderedAmount(Math.max(0, Number(event.target.value)))} placeholder={total.toFixed(2)} /></label><div>{cashOptions.map((value) => <button key={value} onClick={() => setTenderedAmount(value)}>{money.format(value)}</button>)}</div><p><span>Change due</span><strong>{money.format(Math.max(0, Math.round((tenderedAmount - total + Number.EPSILON) * 100) / 100))}</strong></p></div> : <label className="register-reference"><span>{payment} reference · optional</span><input value={paymentReference} maxLength={80} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Transaction or approval number" /></label>}

        <div className="register-paper"><label><span>Receipt template</span><select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>{templates.map((template) => <option key={template._id} value={template._id}>{template.name}{template.isDefault ? " · default" : ""}</option>)}</select></label><label><span>Order note · optional</span><input value={saleNote} maxLength={300} onChange={(event) => setSaleNote(event.target.value)} placeholder="Gift, collection or customer note" /></label></div>
        <button className="checkout-button" disabled={!cart.length || !selectedTemplateId || busy || (payment === "CASH" && tenderedAmount < total)} onClick={checkout}><span>{busy ? "Posting sale…" : "Complete sale"}</span><strong>{money.format(total)}</strong><ChevronRight size={20} /></button>
      </aside>
    </div>}

    <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Sale complete" kicker="RECEIPT READY">{receipt ? <div className="sale-complete"><div className="sale-complete-proof"><ReceiptPaper document={receipt} template={receipt.templateSnapshot} compact /></div><div className="receipt-actions"><Link className="button button-secondary" href={`/receipts/${receipt._id}`}><ExternalLink size={16} />Open & print</Link><button className="button button-primary" onClick={() => setReceipt(null)}>Start next order</button></div></div> : null}</Modal>
    {canManageTemplates ? <ReceiptTemplateStudio open={studioOpen} templates={templates} initialTemplateId={selectedTemplateId} onClose={() => setStudioOpen(false)} onChanged={() => load(false)} /> : null}
  </div>;
}
