"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote, CheckCircle2, ChevronRight, Cloud, CreditCard, ExternalLink, History,
  Minus, Palette, Plus, ReceiptText, Search, ShieldCheck, ShoppingBasket,
  Smartphone, TicketPercent, Trash2, UserRound,
} from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { ReceiptPaper, type ReceiptPaperDocument } from "@/components/receipt-paper";
import { ReceiptTemplateStudio } from "@/components/receipt-template-studio";
import { ScannerBridge } from "@/components/scanner-bridge";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, useNotice } from "@/components/ui";
import { quoteAmount } from "@/lib/exchange-rates";
import { roundCurrency } from "@/lib/international";
import type { PaymentMethodRecord } from "@/lib/payment-methods";
import { clearPosDraft, posDraftStorageKey, readPosDraft, savePosDraft, type PosDraft } from "@/lib/pos-draft";
import type { ReceiptTemplateRecord } from "@/lib/receipt-templates";
import { calculateTaxTotals } from "@/lib/tax";
import type { MemberRecord, ProductRecord } from "@/lib/types";

type CartLine = ProductRecord & { quantity: number };
type RegisterConfig = {
  currency: string;
  acceptedCurrencies: string[];
  locale: string;
  timeZone: string;
  taxName: string;
  taxRate: number;
  taxMode: "EXCLUSIVE" | "INCLUSIVE";
};
type TemplateConfig = { templates: ReceiptTemplateRecord[]; register: RegisterConfig };
type SaleReceipt = ReceiptPaperDocument & { _id: string; templateName?: string; templateSnapshot?: ReceiptTemplateRecord };
type ExchangeRate = { baseCurrency: string; quoteCurrency: string; rate: number; source: string; effectiveAt: string };
type ExchangeData = { baseCurrency: string; acceptedCurrencies: string[]; rates: ExchangeRate[] };
type PaymentIntent = {
  _id: string;
  intentNo: string;
  status: "PENDING" | "VERIFIED" | "CONSUMED";
  paymentMethod: string;
  provider: string;
  baseCurrency: string;
  baseAmount: number;
  tenderCurrency: string;
  tenderAmount: number;
  externalReference?: string;
  expiresAt: string;
};

export function PosView({
  userId,
  canManageTemplates = false,
  canManualDiscount = false,
}: {
  userId: string;
  canManageTemplates?: boolean;
  canManualDiscount?: boolean;
}) {
  const { profile, money } = useBusiness();
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [templates, setTemplates] = useState<ReceiptTemplateRecord[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodRecord[]>([]);
  const [exchange, setExchange] = useState<ExchangeData>({ baseCurrency: profile.currency, acceptedCurrencies: profile.acceptedCurrencies, rates: [] });
  const [register, setRegister] = useState<RegisterConfig>({ currency: profile.currency, acceptedCurrencies: profile.acceptedCurrencies, locale: profile.locale, timeZone: profile.timeZone, taxName: profile.taxName, taxRate: profile.taxRate, taxMode: profile.taxMode });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [memberId, setMemberId] = useState("");
  const [payment, setPayment] = useState("PAYNOW");
  const [tenderCurrency, setTenderCurrency] = useState(profile.currency);
  const [manualDiscount, setManualDiscount] = useState(0);
  const [couponCode, setCouponCode] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState("");
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponName, setCouponName] = useState("");
  const [tenderedAmount, setTenderedAmount] = useState(0);
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentIntent, setPaymentIntent] = useState<PaymentIntent | null>(null);
  const [saleNote, setSaleNote] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [draftHistory, setDraftHistory] = useState<PosDraft[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const { notice, show } = useNotice();
  const draftKey = useMemo(() => posDraftStorageKey(userId), [userId]);
  const draftReadyRef = useRef(false);
  const draftIdRef = useRef("");
  const suppressDraftRef = useRef(false);
  const restoredCouponRef = useRef("");
  const memberRevisionRef = useRef("");

  function restoreDraft(
    draft: PosDraft,
    currentProducts = products,
    currentMembers = members,
    currentTemplates = templates,
    currentPayments = paymentMethods,
    currentExchange = exchange,
  ) {
    const restoredLines = draft.lines.map((saved) => {
      const product = currentProducts.find((item) => item._id === saved.productId && item.active !== false && item.stock > 0);
      return product ? { ...product, quantity: Math.min(saved.quantity, product.stock) } : null;
    }).filter((line): line is CartLine => Boolean(line));
    const method = currentPayments.find((item) => item.code === draft.paymentMethod && item.active !== false);
    const currencies = method?.supportedCurrencies?.length ? method.supportedCurrencies : [currentExchange.baseCurrency];
    const currency = currencies.includes(draft.tenderCurrency) ? draft.tenderCurrency : currencies[0] || currentExchange.baseCurrency;
    setCart(restoredLines);
    setMemberId(currentMembers.some((member) => member._id === draft.memberId && member.active !== false) ? draft.memberId : "");
    setPayment(method?.code || currentPayments[0]?.code || "");
    setTenderCurrency(currency);
    setManualDiscount(canManualDiscount ? Math.max(0, draft.manualDiscount) : 0);
    setCouponCode(draft.couponCode);
    restoredCouponRef.current = draft.couponCode;
    setSaleNote(draft.saleNote);
    setSelectedTemplateId(currentTemplates.some((template) => template._id === draft.templateId) ? draft.templateId : currentTemplates[0]?._id || "");
    setPaymentReference("");
    setPaymentIntent(null);
    draftIdRef.current = draft.draftId;
    if (restoredLines.length) show(`Restored ${restoredLines.length} saved product line${restoredLines.length === 1 ? "" : "s"} from this browser.`);
  }

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const [productData, memberData, templateData, paymentData, exchangeData] = await Promise.all([
        apiRequest<ProductRecord[]>("/api/products"),
        apiRequest<MemberRecord[]>("/api/members"),
        apiRequest<TemplateConfig>("/api/receipt-templates"),
        apiRequest<PaymentMethodRecord[]>("/api/payment-methods"),
        apiRequest<ExchangeData>("/api/exchange-rates"),
      ]);
      setProducts(productData);
      setMembers(memberData);
      setTemplates(templateData.templates);
      setRegister(templateData.register);
      setPaymentMethods(paymentData);
      setExchange(exchangeData);
      const defaultMethod = paymentData.find((method) => method.code === "PAYNOW") || paymentData[0];
      setPayment((current) => paymentData.some((method) => method.code === current) ? current : defaultMethod?.code || "");
      setTenderCurrency((current) => exchangeData.acceptedCurrencies.includes(current) ? current : exchangeData.baseCurrency);
      setSelectedTemplateId((current) => current || (templateData.templates.find((template) => template.isDefault) || templateData.templates[0])?._id || "");
      if (!draftReadyRef.current) {
        const saved = readPosDraft(window.localStorage, draftKey);
        setDraftHistory(saved.history);
        if (saved.active) restoreDraft(saved.active, productData, memberData, templateData.templates, paymentData, exchangeData);
        else draftIdRef.current = crypto.randomUUID();
        draftReadyRef.current = true;
      }
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load the register.", "error"); }
    finally { if (showLoading) setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  const refreshMembers = useCallback(async (force = false) => {
    if (document.visibilityState === "hidden" && !force) return;
    try {
      const revision = await apiRequest<{ revision: string; count: number }>("/api/members?revision=1");
      if (!force && memberRevisionRef.current === revision.revision) return;
      const next = await apiRequest<MemberRecord[]>("/api/members");
      memberRevisionRef.current = revision.revision;
      setMembers(next);
      setMemberId((current) => current && !next.some((member) => member._id === current) ? "" : current);
    } catch { /* the main register load already surfaces connection failures */ }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => { void refreshMembers(); }, 3_000);
    const refresh = () => { if (document.visibilityState === "visible") void refreshMembers(true); };
    const storage = (event: StorageEvent) => { if (event.key === "konkon:members:changed") void refreshMembers(true); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("storage", storage);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("storage", storage); };
  }, [refreshMembers]);

  const categories = useMemo(() => ["All", ...new Set(products.map((product) => product.category))], [products]);
  const filtered = useMemo(() => products.filter((product) => (category === "All" || product.category === category) && `${product.name} ${product.sku} ${product.barcode || ""}`.toLowerCase().includes(search.toLowerCase())), [products, category, search]);
  const subtotalBase = roundCurrency(cart.reduce((sum, line) => sum + line.price * line.quantity, 0), register.currency);
  const discount = Math.min(subtotalBase, roundCurrency(manualDiscount + couponDiscount, register.currency));
  const { subtotal, tax, total } = calculateTaxTotals(subtotalBase, discount, register.taxRate, register.taxMode, register.currency);
  const selectedPayment = paymentMethods.find((method) => method.code === payment);
  const verificationMode = selectedPayment?.verificationMode || "NONE";
  const isCashPayment = selectedPayment?.kind === "CASH";
  const availableCurrencies = selectedPayment?.supportedCurrencies?.length ? selectedPayment.supportedCurrencies : [register.currency];
  const exchangeRate = tenderCurrency === register.currency ? 1 : exchange.rates.find((rate) => rate.quoteCurrency === tenderCurrency)?.rate || 0;
  const tenderTotal = exchangeRate ? quoteAmount(total, exchangeRate, tenderCurrency) : 0;
  const tenderMoney = useMemo(() => new Intl.NumberFormat(register.locale, { style: "currency", currency: tenderCurrency }), [register.locale, tenderCurrency]);
  const cashOptions = [...new Set([tenderTotal, Math.ceil(tenderTotal / 5) * 5, Math.ceil(tenderTotal / 10) * 10, Math.ceil(tenderTotal / 50) * 50])].filter((value) => value >= tenderTotal);

  useEffect(() => {
    if (availableCurrencies.includes(tenderCurrency)) return;
    setTenderCurrency(availableCurrencies[0] || register.currency);
  }, [availableCurrencies, register.currency, tenderCurrency]);

  useEffect(() => {
    if (isCashPayment && tenderedAmount < tenderTotal) setTenderedAmount(tenderTotal);
  }, [isCashPayment, tenderTotal, tenderedAmount]);

  useEffect(() => {
    if (!paymentIntent) return;
    if (paymentIntent.paymentMethod !== payment
      || paymentIntent.tenderCurrency !== tenderCurrency
      || roundCurrency(paymentIntent.baseAmount, register.currency) !== roundCurrency(total, register.currency)
      || roundCurrency(paymentIntent.tenderAmount, tenderCurrency) !== roundCurrency(tenderTotal, tenderCurrency)) {
      setPaymentIntent(null);
    }
  }, [payment, paymentIntent, register.currency, tenderCurrency, tenderTotal, total]);

  const add = useCallback((product: ProductRecord) => {
    if (product.stock <= 0) return;
    setCart((current) => {
      const existing = current.find((line) => line._id === product._id);
      return existing
        ? current.map((line) => line._id === product._id ? { ...line, quantity: Math.min(product.stock, line.quantity + 1) } : line)
        : [...current, { ...product, quantity: 1 }];
    });
  }, []);

  function quantity(id: string, delta: number) {
    setCart((current) => current.map((line) => line._id === id ? { ...line, quantity: Math.min(line.stock, Math.max(0, line.quantity + delta)) } : line).filter((line) => line.quantity > 0));
  }

  function selectPayment(method: PaymentMethodRecord) {
    setPayment(method.code);
    setPaymentReference("");
    setPaymentIntent(null);
    const currency = method.supportedCurrencies?.[0] || register.currency;
    setTenderCurrency(currency);
  }

  const applyCoupon = useCallback(async (rawCode: string, quiet = false) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) { setAppliedCouponCode(""); setCouponDiscount(0); setCouponName(""); return false; }
    if (subtotalBase <= 0) { if (!quiet) show("Add a product before applying a coupon.", "error"); return false; }
    try {
      const result = await apiRequest<{ coupon: { code: string; name: string }; discount: number }>(`/api/coupons?code=${encodeURIComponent(code)}&subtotal=${subtotalBase}&memberId=${encodeURIComponent(memberId)}`);
      setCouponCode(result.coupon.code);
      setAppliedCouponCode(result.coupon.code);
      setCouponDiscount(result.discount);
      setCouponName(result.coupon.name);
      if (!quiet) show(`${result.coupon.code} applied. The server will validate it again at checkout.`);
      return true;
    } catch (reason) {
      setAppliedCouponCode(""); setCouponDiscount(0); setCouponName("");
      if (!quiet) show(reason instanceof Error ? reason.message : "Coupon could not be applied.", "error");
      return false;
    }
  }, [memberId, show, subtotalBase]);

  useEffect(() => {
    if (!appliedCouponCode) return;
    const timer = window.setTimeout(() => { void applyCoupon(appliedCouponCode, true); }, 250);
    return () => window.clearTimeout(timer);
  }, [appliedCouponCode, applyCoupon]);

  useEffect(() => {
    if (loading || !restoredCouponRef.current || subtotalBase <= 0) return;
    const code = restoredCouponRef.current;
    restoredCouponRef.current = "";
    void applyCoupon(code, true);
  }, [applyCoupon, loading, subtotalBase]);

  const persistDraft = useCallback(() => {
    if (!draftReadyRef.current || suppressDraftRef.current) return;
    draftIdRef.current ||= crypto.randomUUID();
    const hasContent = cart.length > 0 || Boolean(memberId || couponCode || saleNote || manualDiscount);
    const draft: PosDraft | null = hasContent ? {
      version: 1,
      draftId: draftIdRef.current,
      updatedAt: new Date().toISOString(),
      lines: cart.map((line) => ({ productId: line._id, quantity: line.quantity, sku: line.sku, name: line.name, price: line.price })),
      memberId,
      paymentMethod: payment,
      tenderCurrency,
      manualDiscount,
      couponCode: appliedCouponCode || couponCode,
      saleNote,
      templateId: selectedTemplateId,
    } : null;
    savePosDraft(window.localStorage, draftKey, draft);
    const saved = readPosDraft(window.localStorage, draftKey);
    setDraftHistory(saved.history);
    setDraftSavedAt(new Date());
  }, [appliedCouponCode, cart, couponCode, draftKey, manualDiscount, memberId, payment, saleNote, selectedTemplateId, tenderCurrency]);

  useEffect(() => {
    if (!draftReadyRef.current) return;
    const timer = window.setTimeout(persistDraft, 220);
    const pageHide = () => persistDraft();
    window.addEventListener("pagehide", pageHide);
    return () => { window.clearTimeout(timer); window.removeEventListener("pagehide", pageHide); persistDraft(); };
  }, [persistDraft]);

  async function verifyScannedPayment(code: string) {
    if (!paymentIntent || paymentIntent.status !== "PENDING") return false;
    try {
      const verified = await apiRequest<PaymentIntent>("/api/payment-intents", { method: "PATCH", body: JSON.stringify({ id: paymentIntent._id, code }) });
      setPaymentIntent(verified);
      show(`${verified.provider} confirmed ${tenderMoney.format(verified.tenderAmount)}. Checkout is now unlocked.`);
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "The provider could not verify this payment code.", "error");
    }
    return true;
  }

  const handleScan = useCallback(async (rawCode: string) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) return;
    if (paymentIntent?.status === "PENDING") { await verifyScannedPayment(code); return; }
    const product = products.find((item) => item.barcode?.toUpperCase() === code || item.sku.toUpperCase() === code);
    if (product) { add(product); show(`${product.name} added from scan.`); return; }
    const member = members.find((item) => item.memberCardCode?.toUpperCase() === code || item.memberNo.toUpperCase() === code);
    if (member) { setMemberId(member._id); show(`${member.name} selected from member card.`); return; }
    if (await applyCoupon(code)) return;
    show(`No product, member card or coupon matches ${code}.`, "error");
  }, [add, applyCoupon, members, paymentIntent, products, show]);

  async function beginProviderVerification() {
    if (!selectedPayment || verificationMode !== "PROVIDER" || !total || !tenderTotal) return;
    try {
      const intent = await apiRequest<PaymentIntent>("/api/payment-intents", { method: "POST", body: JSON.stringify({ paymentMethod: selectedPayment.code, baseAmount: total, tenderCurrency }) });
      setPaymentIntent(intent);
      show(`Verification ${intent.intentNo} started. Scan only the provider's completed-payment code.`);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not start payment verification.", "error"); }
  }

  async function checkout() {
    if (!cart.length || busy || !selectedTemplateId || !selectedPayment) return;
    if (!exchangeRate || !tenderTotal) return show("Configure an active exchange rate before checkout.", "error");
    if (isCashPayment && tenderedAmount < tenderTotal) return show("Enter enough cash to cover the amount due.", "error");
    if (verificationMode === "REFERENCE" && !paymentReference.trim()) return show(`Enter the ${selectedPayment.name} reference before checkout.`, "error");
    if (verificationMode === "PROVIDER" && paymentIntent?.status !== "VERIFIED") return show("Provider confirmation is still missing. Do not release the order.", "error");
    setBusy(true);
    try {
      const result = await apiRequest<SaleReceipt>("/api/sales", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: draftIdRef.current,
          memberId: memberId || null,
          paymentMethod: payment,
          paymentReference,
          paymentIntentId: paymentIntent?._id || "",
          tenderCurrency,
          tenderedAmount: isCashPayment ? tenderedAmount : tenderTotal,
          templateId: selectedTemplateId,
          saleNote,
          manualDiscount,
          couponCode: appliedCouponCode,
          items: cart.map((line) => ({ productId: line._id, quantity: line.quantity })),
        }),
      });
      suppressDraftRef.current = true;
      clearPosDraft(window.localStorage, draftKey);
      draftIdRef.current = crypto.randomUUID();
      setReceipt(result);
      setCart([]);
      setManualDiscount(0);
      setCouponCode("");
      setAppliedCouponCode("");
      setCouponDiscount(0);
      setCouponName("");
      setTenderedAmount(0);
      setPaymentReference("");
      setPaymentIntent(null);
      setSaleNote("");
      setMemberId("");
      await load(false);
      window.setTimeout(() => { suppressDraftRef.current = false; }, 0);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Sale could not be completed.", "error"); }
    finally { setBusy(false); }
  }

  const checkoutLocked = !cart.length || !selectedTemplateId || !selectedPayment || busy || !exchangeRate
    || (isCashPayment && tenderedAmount < tenderTotal)
    || (verificationMode === "REFERENCE" && !paymentReference.trim())
    || (verificationMode === "PROVIDER" && paymentIntent?.status !== "VERIFIED");

  return <div className="page page-enter pos-page">
    <PageHeader eyebrow="COUNTER" title="Point of sale" description="Persistent register with live members, cross-border settlement and verified payment controls." action={<div className="pos-page-actions"><button className="button button-secondary" onClick={() => setHistoryOpen(true)}><History size={17} />Draft history</button><Link className="button button-secondary" href="/receipts"><ReceiptText size={17} />Receipt history</Link>{canManageTemplates ? <button className="button button-secondary" onClick={() => setStudioOpen(true)}><Palette size={17} />Receipt templates</button> : null}</div>} />
    {notice ? <Notice {...notice} /> : null}
    <div className="pos-draft-status"><Cloud size={15} /><span>{draftSavedAt ? `Saved in this browser at ${draftSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Browser draft protection is active"}</span><i />Member list refreshes automatically every 3 seconds and whenever this window regains focus.</div>
    <ScannerBridge contextLabel="Point of sale" purpose="POS" enabled={!loading} placeholder={paymentIntent?.status === "PENDING" ? "Scan completed-payment verification code" : "Scan product · member card · coupon"} onScan={handleScan} onFeedback={show} />
    {loading ? <LoadingPanel label="Opening the register…" /> : <div className="pos-layout">
      <section className="catalog-panel"><div className="catalog-toolbar"><label className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product, barcode or SKU" /></label><span>{filtered.length} items</span></div><div className="category-tabs" role="tablist">{categories.map((name) => <button key={name} className={category === name ? "active" : ""} onClick={() => setCategory(name)}>{name}</button>)}</div>{filtered.length ? <div className="product-grid">{filtered.map((product) => <button className="product-card" key={product._id} onClick={() => add(product)} disabled={product.stock <= 0}><div className="product-top"><span>{product.category}</span><i className={product.stock <= product.reorderLevel ? "low" : ""}>{product.stock ? `${product.stock} left` : "Sold out"}</i></div><div className="product-glyph" aria-hidden="true"><span>{product.name.toLowerCase().includes("hojicha") ? "焙" : product.category === "Dōgu" ? "道" : "抹"}</span></div><strong>{product.name}</strong><small>{product.sku}{product.barcode ? ` · ${product.barcode}` : ""}</small><footer><b>{money.format(product.price)}</b><span><Plus size={16} /></span></footer></button>)}</div> : <EmptyState title="No product found" detail="Try a different search or category." />}</section>
      <aside className="cart-panel"><header><div><span className="eyebrow light">CURRENT ORDER</span><h2>Order <b>{cart.reduce((sum, line) => sum + line.quantity, 0)}</b></h2></div><ShoppingBasket /></header>
        <label className="member-select"><UserRound size={17} /><select value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">Walk-in guest</option>{members.map((member) => <option key={member._id} value={member._id}>{member.name} · {member.points} pts</option>)}</select><ChevronRight size={16} /></label>
        <div className="cart-lines">{cart.length ? cart.map((line) => <div className="cart-line" key={line._id}><div><strong>{line.name}</strong><span>{money.format(line.price)} each</span></div><div className="qty-control"><button onClick={() => quantity(line._id, -1)}>{line.quantity === 1 ? <Trash2 size={14} /> : <Minus size={14} />}</button><b>{line.quantity}</b><button onClick={() => quantity(line._id, 1)} disabled={line.quantity >= line.stock}><Plus size={14} /></button></div><strong>{money.format(line.price * line.quantity)}</strong></div>) : <EmptyState title="The order is empty" detail="Choose or scan a product to begin." />}</div>
        <div className="coupon-register"><label><TicketPercent /><input value={couponCode} onChange={(event) => setCouponCode(event.target.value.toUpperCase())} placeholder="Coupon code" /><button onClick={() => void applyCoupon(couponCode)}>Apply</button></label>{appliedCouponCode ? <p><strong>{appliedCouponCode}</strong><span>{couponName} · −{money.format(couponDiscount)}</span><button onClick={() => { setCouponCode(""); setAppliedCouponCode(""); setCouponDiscount(0); setCouponName(""); }}>Remove</button></p> : null}</div>
        <div className="cart-totals">{canManualDiscount ? <label><span>Manager discount · {register.currency}</span><div><span>{register.currency}</span><input type="number" min="0" max={Math.max(0, subtotal - couponDiscount)} step="0.01" value={manualDiscount || ""} onChange={(event) => setManualDiscount(Math.min(Math.max(0, subtotal - couponDiscount), Math.max(0, Number(event.target.value))))} placeholder="0.00" /></div></label> : null}<p><span>Subtotal</span><b>{money.format(subtotal)}</b></p>{discount > 0 ? <p><span>Discount</span><b>−{money.format(discount)}</b></p> : null}<p><span>{register.taxName} · {register.taxRate}%{register.taxMode === "INCLUSIVE" ? " included" : ""}</span><b>{money.format(tax)}</b></p><p className="grand-total"><span>Amount due</span><strong>{money.format(total)}</strong></p>{tenderCurrency !== register.currency ? <p className="foreign-total"><span>Settlement · 1 {register.currency} = {exchangeRate} {tenderCurrency}</span><strong>{exchangeRate ? tenderMoney.format(tenderTotal) : "Rate missing"}</strong></p> : null}</div>
        <div className="payment-methods"><span>PAYMENT</span><div>{paymentMethods.map((method) => { const Icon = method.kind === "CASH" ? Banknote : method.code.includes("CARD") ? CreditCard : Smartphone; return <button type="button" key={method._id} className={payment === method.code ? "active" : ""} onClick={() => selectPayment(method)} title={`Posts to ${method.accountCode} · ${method.accountName}`}><Icon size={17} />{method.name}</button>; })}</div></div>
        <label className="register-reference"><span>Settlement currency</span><select value={tenderCurrency} onChange={(event) => { setTenderCurrency(event.target.value); setPaymentIntent(null); }}>{availableCurrencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
        {isCashPayment ? <div className="cash-tender"><label><span>Cash received · {tenderCurrency}</span><input type="number" min={tenderTotal} step="0.01" value={tenderedAmount || ""} onChange={(event) => setTenderedAmount(Math.max(0, Number(event.target.value)))} placeholder={tenderTotal.toFixed(2)} /></label><div>{cashOptions.map((value) => <button type="button" key={value} onClick={() => setTenderedAmount(value)}>{tenderMoney.format(value)}</button>)}</div><p><span>Change due</span><strong>{tenderMoney.format(Math.max(0, roundCurrency(tenderedAmount - tenderTotal, tenderCurrency)))}</strong></p></div> : verificationMode === "PROVIDER" ? <div className={`verified-payment ${paymentIntent?.status.toLowerCase() || "idle"}`}><div><ShieldCheck /><span><strong>{paymentIntent?.status === "VERIFIED" ? "Provider payment verified" : paymentIntent?.status === "PENDING" ? "Waiting for confirmed-payment code" : "Strict verification required"}</strong><small>{paymentIntent ? `${paymentIntent.intentNo} · ${paymentIntent.provider} · ${tenderMoney.format(paymentIntent.tenderAmount)}` : "A scanned image or static QR alone never unlocks checkout."}</small></span></div>{paymentIntent?.status === "VERIFIED" ? <CheckCircle2 /> : <button type="button" className="button button-primary" onClick={() => void beginProviderVerification()} disabled={!cart.length || !exchangeRate}>{paymentIntent ? "Restart verification" : "Start secure verification"}</button>}</div> : <label className="register-reference"><span>{selectedPayment?.name || "Payment"} reference · required</span><input value={paymentReference} maxLength={80} required onChange={(event) => setPaymentReference(event.target.value)} placeholder="Transaction or approval number" /></label>}
        <div className="register-paper"><label><span>Receipt template</span><select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>{templates.map((template) => <option key={template._id} value={template._id}>{template.name}{template.isDefault ? " · default" : ""}</option>)}</select></label><label><span>Order note · optional</span><input value={saleNote} maxLength={300} onChange={(event) => setSaleNote(event.target.value)} placeholder="Collection or customer note" /></label></div>
        <button className="checkout-button" disabled={checkoutLocked} onClick={checkout}><span>{busy ? "Posting sale…" : verificationMode === "PROVIDER" && paymentIntent?.status !== "VERIFIED" ? "Awaiting verified payment" : "Complete sale"}</span><strong>{tenderCurrency === register.currency ? money.format(total) : tenderMoney.format(tenderTotal)}</strong><ChevronRight size={20} /></button>
      </aside>
    </div>}
    <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Browser draft history" kicker="THIS REGISTER ONLY"><div className="draft-history-list">{draftHistory.length ? draftHistory.map((draft) => <article key={`${draft.draftId}-${draft.updatedAt}`}><div><strong>{draft.lines.reduce((sum, line) => sum + line.quantity, 0)} items · {draft.paymentMethod || "No payment"}</strong><span>{new Intl.DateTimeFormat(register.locale, { dateStyle: "medium", timeStyle: "short", timeZone: register.timeZone }).format(new Date(draft.updatedAt))}</span></div><button className="button button-secondary" onClick={() => { restoreDraft(draft); setHistoryOpen(false); }}>Restore</button></article>) : <EmptyState title="No earlier drafts" detail="Periodic browser snapshots will appear here while an order changes." />}</div></Modal>
    <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Sale complete" kicker="RECEIPT READY">{receipt ? <div className="sale-complete"><div className="sale-complete-proof"><ReceiptPaper document={receipt} template={receipt.templateSnapshot} compact /></div><div className="receipt-actions"><Link className="button button-secondary" href={`/receipts/${receipt._id}`}><ExternalLink size={16} />Open & print</Link><button className="button button-primary" onClick={() => setReceipt(null)}>Start next order</button></div></div> : null}</Modal>
    {canManageTemplates ? <ReceiptTemplateStudio open={studioOpen} templates={templates} initialTemplateId={selectedTemplateId} onClose={() => setStudioOpen(false)} onChanged={() => load(false)} /> : null}
  </div>;
}
