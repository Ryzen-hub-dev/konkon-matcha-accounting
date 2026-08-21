"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Banknote, Barcode, ChevronRight, Copy, CreditCard, ExternalLink, Link2, Minus, Palette, Plus,
  ReceiptText, ScanLine, Search, ShoppingBasket, Smartphone, TicketPercent, Trash2, Unplug, UserRound,
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
type ScannerSession = { _id: string; label: string; expiresAt: string; lastUsedAt?: string };
type ScanEvent = { _id: string; code: string; createdAt: string };

export function PosView({ canManageTemplates = false, canManualDiscount = false }: { canManageTemplates?: boolean; canManualDiscount?: boolean }) {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [templates, setTemplates] = useState<ReceiptTemplateRecord[]>([]);
  const [register, setRegister] = useState<RegisterConfig>({ currency: "SGD", taxName: "GST", taxRate: 0, taxMode: "EXCLUSIVE" });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [search, setSearch] = useState("");
  const [scanCode, setScanCode] = useState("");
  const [category, setCategory] = useState("All");
  const [memberId, setMemberId] = useState("");
  const [payment, setPayment] = useState("PAYNOW");
  const [manualDiscount, setManualDiscount] = useState(0);
  const [couponCode, setCouponCode] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState("");
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponName, setCouponName] = useState("");
  const [tenderedAmount, setTenderedAmount] = useState(0);
  const [paymentReference, setPaymentReference] = useState("");
  const [saleNote, setSaleNote] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerSessions, setScannerSessions] = useState<ScannerSession[]>([]);
  const [selectedScannerId, setSelectedScannerId] = useState("");
  const [issuedScannerUrl, setIssuedScannerUrl] = useState("");
  const { notice, show } = useNotice();

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const [productData, memberData, templateData] = await Promise.all([
        apiRequest<ProductRecord[]>("/api/products"), apiRequest<MemberRecord[]>("/api/members"), apiRequest<TemplateConfig>("/api/receipt-templates"),
      ]);
      setProducts(productData); setMembers(memberData); setTemplates(templateData.templates); setRegister(templateData.register);
      setSelectedTemplateId((current) => current || (templateData.templates.find((template) => template.isDefault) || templateData.templates[0])?._id || "");
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load the register.", "error"); }
    finally { if (showLoading) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const categories = useMemo(() => ["All", ...new Set(products.map((product) => product.category))], [products]);
  const filtered = useMemo(() => products.filter((product) => (category === "All" || product.category === category) && `${product.name} ${product.sku} ${product.barcode || ""}`.toLowerCase().includes(search.toLowerCase())), [products, category, search]);
  const subtotalBase = Math.round((cart.reduce((sum, line) => sum + line.price * line.quantity, 0) + Number.EPSILON) * 100) / 100;
  const discount = Math.min(subtotalBase, Math.round((manualDiscount + couponDiscount + Number.EPSILON) * 100) / 100);
  const { subtotal, tax, total } = calculateTaxTotals(subtotalBase, discount, register.taxRate, register.taxMode);
  const cashOptions = [...new Set([total, Math.ceil(total / 5) * 5, Math.ceil(total / 10) * 10, Math.ceil(total / 50) * 50])].filter((value) => value >= total);

  const add = useCallback((product: ProductRecord) => {
    if (product.stock <= 0) return;
    setCart((current) => { const existing = current.find((line) => line._id === product._id); return existing ? current.map((line) => line._id === product._id ? { ...line, quantity: Math.min(product.stock, line.quantity + 1) } : line) : [...current, { ...product, quantity: 1 }]; });
  }, []);
  function quantity(id: string, delta: number) { setCart((current) => current.map((line) => line._id === id ? { ...line, quantity: Math.min(line.stock, Math.max(0, line.quantity + delta)) } : line).filter((line) => line.quantity > 0)); }
  function selectPayment(method: string) { setPayment(method); setPaymentReference(""); if (method === "CASH") setTenderedAmount(total); }

  const applyCoupon = useCallback(async (rawCode: string, quiet = false) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) { setAppliedCouponCode(""); setCouponDiscount(0); setCouponName(""); return false; }
    if (subtotalBase <= 0) { if (!quiet) show("Add a product before applying a coupon.", "error"); return false; }
    try {
      const result = await apiRequest<{ coupon: { code: string; name: string }; discount: number }>(`/api/coupons?code=${encodeURIComponent(code)}&subtotal=${subtotalBase}&memberId=${encodeURIComponent(memberId)}`);
      setCouponCode(result.coupon.code); setAppliedCouponCode(result.coupon.code); setCouponDiscount(result.discount); setCouponName(result.coupon.name);
      if (!quiet) show(`${result.coupon.code} applied. The server will validate it again at checkout.`);
      return true;
    } catch (reason) { setAppliedCouponCode(""); setCouponDiscount(0); setCouponName(""); if (!quiet) show(reason instanceof Error ? reason.message : "Coupon could not be applied.", "error"); return false; }
  }, [memberId, show, subtotalBase]);

  useEffect(() => {
    if (!appliedCouponCode) return;
    const timer = window.setTimeout(() => { void applyCoupon(appliedCouponCode, true); }, 250);
    return () => window.clearTimeout(timer);
  }, [appliedCouponCode, applyCoupon]);

  const handleScan = useCallback(async (rawCode: string) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) return;
    const product = products.find((item) => item.barcode?.toUpperCase() === code || item.sku.toUpperCase() === code);
    if (product) { add(product); show(`${product.name} added from scan.`); return; }
    const member = members.find((item) => item.memberCardCode?.toUpperCase() === code || item.memberNo.toUpperCase() === code);
    if (member) { setMemberId(member._id); show(`${member.name} selected from member card.`); return; }
    if (await applyCoupon(code)) return;
    show(`No product, member card or coupon matches ${code}.`, "error");
  }, [add, applyCoupon, members, products, show]);

  function submitScan(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const code = scanCode; setScanCode(""); void handleScan(code); }

  async function loadScanners() {
    try { const result = await apiRequest<{ sessions: ScannerSession[] }>("/api/scanner-sessions"); setScannerSessions(result.sessions); setSelectedScannerId((current) => current || result.sessions[0]?._id || ""); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load scanner links.", "error"); }
  }
  useEffect(() => { if (scannerOpen) void loadScanners(); }, [scannerOpen]);
  useEffect(() => {
    if (!selectedScannerId) return;
    let stopped = false; let polling = false;
    const poll = async () => {
      if (stopped || polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const events = await apiRequest<ScanEvent[]>(`/api/mobile-scans?sessionId=${selectedScannerId}`);
        for (const event of events) await handleScan(event.code);
        if (events.length) await apiRequest("/api/mobile-scans", { method: "PATCH", body: JSON.stringify({ sessionId: selectedScannerId, eventIds: events.map((event) => event._id) }) });
      } catch (reason) { if (reason instanceof Error && /expired|inactive|closed/i.test(reason.message)) { setSelectedScannerId(""); show(reason.message, "error"); } }
      finally { polling = false; }
    };
    void poll(); const timer = window.setInterval(poll, 4000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [handleScan, selectedScannerId, show]);
  async function createScanner(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const label = String(new FormData(event.currentTarget).get("label") || "Counter phone"); try { const result = await apiRequest<{ session: ScannerSession; url: string }>("/api/scanner-sessions", { method: "POST", body: JSON.stringify({ label }) }); setIssuedScannerUrl(result.url); setSelectedScannerId(result.session._id); show("24-hour scanner pass issued."); await loadScanners(); } catch (reason) { show(reason instanceof Error ? reason.message : "Could not issue the scanner link.", "error"); } }
  async function revokeScanner(session: ScannerSession) { try { await apiRequest("/api/scanner-sessions", { method: "DELETE", body: JSON.stringify({ id: session._id }) }); if (selectedScannerId === session._id) setSelectedScannerId(""); setIssuedScannerUrl(""); show("Scanner link revoked immediately."); await loadScanners(); } catch (reason) { show(reason instanceof Error ? reason.message : "Could not revoke the scanner link.", "error"); } }

  async function checkout() {
    if (!cart.length || busy || !selectedTemplateId) return;
    if (payment === "CASH" && tenderedAmount < total) return show("Enter enough cash to cover the amount due.", "error");
    setBusy(true);
    try {
      const result = await apiRequest<SaleReceipt>("/api/sales", { method: "POST", body: JSON.stringify({ memberId: memberId || null, paymentMethod: payment, paymentReference, tenderedAmount: payment === "CASH" ? tenderedAmount : total, templateId: selectedTemplateId, saleNote, manualDiscount, couponCode: appliedCouponCode, items: cart.map((line) => ({ productId: line._id, quantity: line.quantity })) }) });
      setReceipt(result); setCart([]); setManualDiscount(0); setCouponCode(""); setAppliedCouponCode(""); setCouponDiscount(0); setCouponName(""); setTenderedAmount(0); setPaymentReference(""); setSaleNote(""); setMemberId(""); await load(false);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Sale could not be completed.", "error"); }
    finally { setBusy(false); }
  }

  return <div className="page page-enter pos-page">
    <PageHeader eyebrow="COUNTER" title="Point of sale" description="Scan products, member cards and coupons through one trusted register." action={<div className="pos-page-actions"><button className={`button ${selectedScannerId ? "button-primary" : "button-secondary"}`} onClick={() => setScannerOpen(true)}><Smartphone size={17} />{selectedScannerId ? "Phone linked" : "Link phone scanner"}</button><Link className="button button-secondary" href="/receipts"><ReceiptText size={17} />Receipt history</Link>{canManageTemplates ? <button className="button button-secondary" onClick={() => setStudioOpen(true)}><Palette size={17} />Receipt templates</button> : null}</div>} />
    {notice ? <Notice {...notice} /> : null}
    <form className="scan-dock" onSubmit={submitScan}><div className="scan-dock-mark"><ScanLine /><i /></div><label><span>UNIFIED SCAN INPUT</span><input value={scanCode} onChange={(event) => setScanCode(event.target.value)} autoComplete="off" autoCapitalize="characters" placeholder="Focus here and scan product · member card · coupon" /></label><button><Barcode />Read code</button><small>{selectedScannerId ? "PHONE PASS LISTENING" : "USB / BLUETOOTH READY"}</small></form>
    {loading ? <LoadingPanel label="Opening the register…" /> : <div className="pos-layout"><section className="catalog-panel"><div className="catalog-toolbar"><label className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tea, barcode, dōgu or SKU" /></label><span>{filtered.length} items</span></div><div className="category-tabs" role="tablist">{categories.map((name) => <button key={name} className={category === name ? "active" : ""} onClick={() => setCategory(name)}>{name}</button>)}</div>{filtered.length ? <div className="product-grid">{filtered.map((product) => <button className="product-card" key={product._id} onClick={() => add(product)} disabled={product.stock <= 0}><div className="product-top"><span>{product.category}</span><i className={product.stock <= product.reorderLevel ? "low" : ""}>{product.stock ? `${product.stock} left` : "Sold out"}</i></div><div className="product-glyph" aria-hidden="true"><span>{product.name.toLowerCase().includes("hojicha") ? "焙" : product.category === "Dōgu" ? "道" : "抹"}</span></div><strong>{product.name}</strong><small>{product.sku}{product.barcode ? ` · ${product.barcode}` : ""}</small><footer><b>{money.format(product.price)}</b><span><Plus size={16} /></span></footer></button>)}</div> : <EmptyState title="No tea found" detail="Try a different search or category." />}</section>
      <aside className="cart-panel"><header><div><span className="eyebrow light">CURRENT ORDER</span><h2>Tea tray <b>{cart.reduce((sum, line) => sum + line.quantity, 0)}</b></h2></div><ShoppingBasket /></header><label className="member-select"><UserRound size={17} /><select value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">Walk-in guest</option>{members.map((member) => <option key={member._id} value={member._id}>{member.name} · {member.points} pts</option>)}</select><ChevronRight size={16} /></label><div className="cart-lines">{cart.length ? cart.map((line) => <div className="cart-line" key={line._id}><div><strong>{line.name}</strong><span>{money.format(line.price)} each</span></div><div className="qty-control"><button onClick={() => quantity(line._id, -1)}>{line.quantity === 1 ? <Trash2 size={14} /> : <Minus size={14} />}</button><b>{line.quantity}</b><button onClick={() => quantity(line._id, 1)} disabled={line.quantity >= line.stock}><Plus size={14} /></button></div><strong>{money.format(line.price * line.quantity)}</strong></div>) : <EmptyState title="The tray is empty" detail="Choose or scan a product to begin." />}</div>
        <div className="coupon-register"><label><TicketPercent /><input value={couponCode} onChange={(event) => setCouponCode(event.target.value.toUpperCase())} placeholder="Coupon code" /><button onClick={() => void applyCoupon(couponCode)}>Apply</button></label>{appliedCouponCode ? <p><strong>{appliedCouponCode}</strong><span>{couponName} · −{money.format(couponDiscount)}</span><button onClick={() => { setCouponCode(""); setAppliedCouponCode(""); setCouponDiscount(0); setCouponName(""); }}>Remove</button></p> : null}</div>
        <div className="cart-totals">{canManualDiscount ? <label><span>Manager discount</span><div><span>$</span><input type="number" min="0" max={Math.max(0, subtotal - couponDiscount)} step="0.01" value={manualDiscount || ""} onChange={(event) => setManualDiscount(Math.min(Math.max(0, subtotal - couponDiscount), Math.max(0, Number(event.target.value))))} placeholder="0.00" /></div></label> : null}<p><span>Subtotal</span><b>{money.format(subtotal)}</b></p>{discount > 0 ? <p><span>Discount</span><b>−{money.format(discount)}</b></p> : null}<p><span>{register.taxName} · {register.taxRate}%{register.taxMode === "INCLUSIVE" ? " included" : ""}</span><b>{money.format(tax)}</b></p><p className="grand-total"><span>Amount due</span><strong>{money.format(total)}</strong></p></div>
        <div className="payment-methods"><span>PAYMENT</span><div>{[{ id: "CASH", icon: Banknote }, { id: "CARD", icon: CreditCard }, { id: "PAYNOW", icon: Smartphone }].map(({ id, icon: Icon }) => <button key={id} className={payment === id ? "active" : ""} onClick={() => selectPayment(id)}><Icon size={17} />{id}</button>)}</div></div>{payment === "CASH" ? <div className="cash-tender"><label><span>Cash received</span><input type="number" min={total} step="0.01" value={tenderedAmount || ""} onChange={(event) => setTenderedAmount(Math.max(0, Number(event.target.value)))} placeholder={total.toFixed(2)} /></label><div>{cashOptions.map((value) => <button key={value} onClick={() => setTenderedAmount(value)}>{money.format(value)}</button>)}</div><p><span>Change due</span><strong>{money.format(Math.max(0, Math.round((tenderedAmount - total + Number.EPSILON) * 100) / 100))}</strong></p></div> : <label className="register-reference"><span>{payment} reference · optional</span><input value={paymentReference} maxLength={80} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Transaction or approval number" /></label>}<div className="register-paper"><label><span>Receipt template</span><select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>{templates.map((template) => <option key={template._id} value={template._id}>{template.name}{template.isDefault ? " · default" : ""}</option>)}</select></label><label><span>Order note · optional</span><input value={saleNote} maxLength={300} onChange={(event) => setSaleNote(event.target.value)} placeholder="Gift, collection or customer note" /></label></div><button className="checkout-button" disabled={!cart.length || !selectedTemplateId || busy || (payment === "CASH" && tenderedAmount < total)} onClick={checkout}><span>{busy ? "Posting sale…" : "Complete sale"}</span><strong>{money.format(total)}</strong><ChevronRight size={20} /></button></aside></div>}
    <Modal open={scannerOpen} onClose={() => setScannerOpen(false)} title="24-hour phone scanner" kicker="RESTRICTED PASS"><div className="scanner-link-panel"><div className="scanner-link-intro"><Link2 /><div><strong>One-purpose access</strong><p>The phone can only send scanned codes. It cannot read products, members, prices or reports. Closing the system or revoking the pass invalidates it immediately.</p></div></div><form onSubmit={createScanner}><label className="field"><span>Device label</span><input name="label" defaultValue="Counter phone" required /></label><button className="button button-primary"><Plus size={15} />Issue 24-hour pass</button></form>{issuedScannerUrl ? <div className="issued-scanner-link"><span>COPY ONCE · OPEN ON THE PHONE</span><code>{issuedScannerUrl}</code><button className="button button-secondary" onClick={() => navigator.clipboard.writeText(issuedScannerUrl)}><Copy size={15} />Copy secure link</button></div> : null}<div className="scanner-session-list">{scannerSessions.map((session) => <article key={session._id} className={selectedScannerId === session._id ? "listening" : ""}><div><strong>{session.label}</strong><span>Expires {new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(session.expiresAt))}</span></div><button className="button button-secondary" onClick={() => setSelectedScannerId(session._id)}>{selectedScannerId === session._id ? <><ScanLine size={14} />Listening</> : "Listen"}</button><button className="icon-button danger" title="Revoke scanner link" onClick={() => revokeScanner(session)}><Unplug size={15} /></button></article>)}</div></div></Modal>
    <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Sale complete" kicker="RECEIPT READY">{receipt ? <div className="sale-complete"><div className="sale-complete-proof"><ReceiptPaper document={receipt} template={receipt.templateSnapshot} compact /></div><div className="receipt-actions"><Link className="button button-secondary" href={`/receipts/${receipt._id}`}><ExternalLink size={16} />Open & print</Link><button className="button button-primary" onClick={() => setReceipt(null)}>Start next order</button></div></div> : null}</Modal>{canManageTemplates ? <ReceiptTemplateStudio open={studioOpen} templates={templates} initialTemplateId={selectedTemplateId} onClose={() => setStudioOpen(false)} onChanged={() => load(false)} /> : null}
  </div>;
}
