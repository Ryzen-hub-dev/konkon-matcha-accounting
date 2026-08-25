"use client";

import { FormEvent, useEffect, useState } from "react";
import { Archive, Banknote, CreditCard, Globe2, Landmark, Pencil, Plus, QrCode, ReceiptText, RotateCcw, ShieldCheck, Upload } from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { LocalPaymentBridgePanel } from "@/components/local-payment-bridge-panel";
import { buildAmountLockedDuitNowQr, inspectDuitNowQr } from "@/lib/duitnow-qr";
import type { PaymentMethodRecord } from "@/lib/payment-methods";
import { CURRENCY_OPTIONS } from "@/lib/international";
import { PAYMENT_PROVIDERS, PAYMENT_VERIFICATION_MODES } from "@/lib/payment-verification";

type AssetAccount = { _id: string; code: string; name: string; type: "ASSET" };
type ExchangeRate = { _id?: string; baseCurrency: string; quoteCurrency: string; rate: number; source: string; effectiveAt: string };
type ExchangeData = { baseCurrency: string; acceptedCurrencies: string[]; rates: ExchangeRate[] };

export function PaymentMethodsView() {
  const [methods, setMethods] = useState<PaymentMethodRecord[]>([]);
  const [accounts, setAccounts] = useState<AssetAccount[]>([]);
  const [exchange, setExchange] = useState<ExchangeData | null>(null);
  const [editing, setEditing] = useState<PaymentMethodRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qrPayload, setQrPayload] = useState("");
  const [formError, setFormError] = useState("");
  const { notice, show } = useNotice();

  function openNewMethod() {
    setEditing(null);
    setRestoring(false);
    setQrPayload("");
    setFormError("");
    setAdding(true);
  }

  function openMethod(method: PaymentMethodRecord, restore = false) {
    setAdding(false);
    setEditing(method);
    setRestoring(restore);
    setQrPayload(method.qrPayload || "");
    setFormError("");
  }

  function closeMethod() {
    setAdding(false);
    setEditing(null);
    setRestoring(false);
    setQrPayload("");
    setFormError("");
  }

  async function load() {
    setLoading(true);
    try {
      const [paymentData, accountData, exchangeData] = await Promise.all([
        apiRequest<PaymentMethodRecord[]>("/api/payment-methods?includeArchived=1"),
        apiRequest<AssetAccount[]>("/api/payment-methods/accounts"),
        apiRequest<ExchangeData>("/api/exchange-rates"),
      ]);
      setMethods(paymentData);
      setAccounts(accountData);
      setExchange(exchangeData);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load payment methods.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFormError("");
    const form = new FormData(event.currentTarget);
    const body = {
      ...(editing ? { id: editing._id, ...(restoring ? { active: true } : {}) } : {}),
      code: String(form.get("code") || "").toUpperCase(),
      name: String(form.get("name") || ""),
      kind: String(form.get("kind") || ""),
      accountCode: String(form.get("accountCode") || ""),
      sortOrder: String(form.get("sortOrder") || ""),
      referenceRequired: form.has("referenceRequired"),
      verificationMode: String(form.get("verificationMode") || ""),
      providerCode: String(form.get("providerCode") || "") || undefined,
      qrPayload,
      supportedCurrencies: form.getAll("supportedCurrencies").map(String),
    };
    const disabledCurrency = body.supportedCurrencies.find((currency) => !exchange?.acceptedCurrencies.includes(currency));
    if (disabledCurrency) {
      setFormError(`Enable ${disabledCurrency} under Workspace settings before using it for this payment method.`);
      return;
    }
    if (body.verificationMode === "STATIC_QR" && qrPayload.trim().length < 8) {
      setFormError("Import an official recipient QR before enabling static QR collection.");
      return;
    }
    const isTng = body.code === "TNG" || body.providerCode === "TNG";
    if (body.verificationMode === "STATIC_QR" && isTng) {
      if (!exchange?.acceptedCurrencies.includes("MYR")) {
        setFormError("Enable MYR under Workspace settings before configuring TNG collection.");
        return;
      }
      if (!body.supportedCurrencies.includes("MYR")) {
        setFormError("Select MYR under Accepted currencies for this TNG payment method.");
        return;
      }
      try { buildAmountLockedDuitNowQr(qrPayload, 1, "MYR"); }
      catch (reason) {
        setFormError(reason instanceof Error ? reason.message : "Import a valid DuitNow recipient QR for TNG.");
        return;
      }
    }
    setBusy(true);
    try {
      await apiRequest("/api/payment-methods", { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      show(restoring ? "Payment method restored and available at POS." : editing ? "Payment method updated." : "Payment method added to the register.");
      closeMethod();
      await load();
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : "Could not save the payment method."); }
    finally { setBusy(false); }
  }

  async function archiveMethod(method: PaymentMethodRecord) {
    if (!window.confirm(`Archive ${method.name}? Existing receipts and journal entries will remain unchanged.`)) return;
    try {
      await apiRequest("/api/payment-methods", { method: "DELETE", body: JSON.stringify({ id: method._id }) });
      show(`${method.name} archived.`);
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change the payment method.", "error"); }
  }

  async function saveRate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/exchange-rates", { method: "PATCH", body: JSON.stringify({ quoteCurrency: form.get("quoteCurrency"), rate: form.get("rate"), source: form.get("source") }) });
      show("Exchange rate locked for new POS payments. Existing receipts keep their original rate.");
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not save the exchange rate.", "error"); }
  }

  async function decodeRecipientQr(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 5_000_000) return show("Choose a QR image up to 5 MB.", "error");
    const url = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      const payload = result.getText().trim();
      if (payload.length < 8 || payload.length > 4096) throw new Error("The image does not contain a supported recipient QR.");
      setQrPayload(payload);
      setFormError("");
      try {
        inspectDuitNowQr(payload);
        show("Valid DuitNow recipient QR imported. POS fixed-amount generation is available; confirm the recipient before saving.");
      } catch {
        show("Recipient QR imported. It is not an amount-lockable DuitNow QR, so confirm the provider and recipient before saving.");
      }
    } catch (reason) { show(reason instanceof Error ? reason.message : "The QR image could not be read.", "error"); }
    finally { URL.revokeObjectURL(url); }
  }

  const active = methods.filter((method) => method.active !== false);
  const referenceCount = active.filter((method) => method.referenceRequired).length;
  const selected = editing;

  return <div className="page page-enter payment-page">
    <PageHeader eyebrow="REGISTER ROUTING" title="Payment methods" description="Add the tender names staff see at checkout and control exactly where each amount posts in the ledger." action={<button className="button button-primary" onClick={openNewMethod}><Plus />New payment method</button>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="payment-route-hero"><div><Banknote /><span>ACTIVE TENDERS</span><strong>{active.length}</strong></div><i /><div><ShieldCheck /><span>REFERENCE CONTROL</span><strong>{referenceCount}</strong></div><i /><p><b>One sale, one trusted route.</b><span>Every POS payment is revalidated by the API and debited to the chosen cash or bank asset account.</span></p></section>
    <LocalPaymentBridgePanel />
    {loading ? <LoadingPanel label="Reading the till routes…" /> : methods.length ? <section className="payment-route-list">{methods.map((method) => {
      const Icon = method.kind === "CASH" ? Banknote : method.code.includes("CARD") ? CreditCard : Landmark;
      return <article key={method._id} className={method.active === false ? "archived" : ""}>
        <div className="payment-route-stamp"><Icon /></div>
        <div><span>{method.code}</span><strong>{method.name}</strong><small>{method.verificationMode === "PROVIDER" ? `${method.providerCode || "Provider"} confirmation required` : method.verificationMode === "STATIC_QR" ? "Static recipient QR · staff confirms real credit" : method.referenceRequired ? "Transaction reference required" : "Reference optional"}</small></div>
        <div className="payment-route-line"><i /><ReceiptText /><i /></div>
        <div><span>LEDGER DESTINATION</span><strong>{method.accountCode} · {method.accountName}</strong><small>{method.kind === "CASH" ? "Cash tender · change enabled" : "Non-cash tender · exact amount"} · {(method.supportedCurrencies || []).join(" / ") || exchange?.baseCurrency}</small></div>
        <StatusPill value={method.active === false ? "ARCHIVED" : "ACTIVE"} />
        <div className="row-actions">{method.active === false ? <><button className="icon-button" title="Configure payment method" onClick={() => openMethod(method)}><Pencil /></button><button className="button button-secondary" onClick={() => openMethod(method, true)}><RotateCcw />Restore</button></> : <><button className="icon-button" title="Edit payment method" onClick={() => openMethod(method)}><Pencil /></button><button className="icon-button danger" title="Archive payment method" onClick={() => void archiveMethod(method)}><Archive /></button></>}</div>
      </article>;
    })}</section> : <EmptyState title="No payment routes" detail="Add at least one cash or non-cash method before using the register." action={<button className="button button-primary" onClick={openNewMethod}><Plus />Add payment method</button>} />}
    {exchange ? <section className="panel exchange-rate-panel"><header className="panel-header"><div><span className="eyebrow">CROSS-BORDER SETTLEMENT</span><h2>{exchange.baseCurrency} exchange rates</h2></div><Globe2 /></header><p>Rates are quoted as foreign currency per 1 {exchange.baseCurrency}. Every completed receipt stores the exact rate used.</p><div className="exchange-rate-list">{exchange.rates.map((rate) => <div key={rate.quoteCurrency}><strong>{rate.baseCurrency}/{rate.quoteCurrency}</strong><span>{rate.rate.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span><small>{rate.source}</small></div>)}</div>{exchange.acceptedCurrencies.some((currency) => currency !== exchange.baseCurrency) ? <form className="exchange-rate-form" onSubmit={saveRate}><label className="field"><span>Settlement currency</span><select name="quoteCurrency" defaultValue={exchange.acceptedCurrencies.find((currency) => currency !== exchange.baseCurrency)}>{exchange.acceptedCurrencies.filter((currency) => currency !== exchange.baseCurrency).map((currency) => <option key={currency}>{currency}</option>)}</select></label><label className="field"><span>Rate per 1 {exchange.baseCurrency}</span><input name="rate" type="number" min="0.00000001" max="1000000000" step="0.00000001" required /></label><label className="field"><span>Source</span><input name="source" defaultValue="MANUAL TREASURY RATE" maxLength={60} required /></label><button className="button button-primary">Save locked rate</button></form> : <p className="form-hint">Add another accepted currency in Workspace settings before creating an FX rate.</p>}</section> : null}
    <Modal open={adding || Boolean(editing)} onClose={closeMethod} title={restoring && selected ? `Restore ${selected.name}` : selected ? `Edit ${selected.name}` : "New payment method"} kicker="TENDER + LEDGER">
      <form className="modal-form" onSubmit={save} key={selected?._id || "new-payment"}>
        {restoring ? <p className="form-hint">Review the configuration below. Saving will validate and restore this payment method in one step.</p> : null}
        {formError ? <Notice message={formError} tone="error" /> : null}
        <div className="form-grid two"><label className="field"><span>Display name</span><input name="name" defaultValue={selected?.name} placeholder="GrabPay" minLength={2} maxLength={60} required /></label><label className="field"><span>Code</span><input name="code" defaultValue={selected?.code} placeholder="GRABPAY" pattern="[A-Za-z0-9_\-]{2,24}" required /></label></div>
        <div className="form-grid two"><label className="field"><span>Payment behaviour</span><select name="kind" defaultValue={selected?.kind || "NON_CASH"}><option value="CASH">Cash · tender and change</option><option value="NON_CASH">Non-cash · exact amount</option></select></label><label className="field"><span>Asset account</span><select name="accountCode" defaultValue={selected?.accountCode || accounts[0]?.code} required>{accounts.map((account) => <option key={account._id} value={account.code}>{account.code} · {account.name}</option>)}</select></label></div>
        <div className="form-grid two"><label className="field"><span>Verification control</span><select name="verificationMode" defaultValue={selected?.verificationMode || "NONE"}>{PAYMENT_VERIFICATION_MODES.map((mode) => <option key={mode} value={mode}>{mode === "PROVIDER" ? "Provider-confirmed · strict" : mode === "STATIC_QR" ? "Static recipient QR · manual credit check" : mode === "REFERENCE" ? "Staff-entered reference" : "No external verification"}</option>)}</select></label><label className="field"><span>Provider</span><select name="providerCode" defaultValue={selected?.providerCode || "GENERIC"}>{PAYMENT_PROVIDERS.map((provider) => <option key={provider}>{provider}</option>)}</select></label></div>
        <div className="static-qr-config"><div><QrCode /><span><strong>Recipient QR for static collection</strong><small>Import the QR issued by the receiving bank or wallet. For TNG/DuitNow, POS validates the payload, inserts the exact MYR amount and recalculates its CRC.</small></span></div><label className="button button-secondary"><Upload />Read QR image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void decodeRecipientQr(event)} /></label><label className="field"><span>QR payload</span><textarea value={qrPayload} onChange={(event) => setQrPayload(event.target.value)} maxLength={4096} placeholder="Import from an official PayNow, DuitNow or wallet QR image" /></label><p><ShieldCheck /><span><strong>Anti-escape control</strong>TNG can only be saved with an amount-lockable DuitNow recipient QR. Checkout still requires staff to see the successful credit in the receiver app and enter the transaction reference.</span></p></div>
        <label className="field"><span>Accepted currencies for this method</span><select name="supportedCurrencies" multiple size={5} defaultValue={selected?.supportedCurrencies?.length ? selected.supportedCurrencies : [exchange?.baseCurrency || "SGD"]}>{CURRENCY_OPTIONS.filter((currency) => exchange?.acceptedCurrencies.includes(currency) || selected?.supportedCurrencies?.includes(currency)).map((currency) => <option key={currency} value={currency}>{currency}{exchange?.acceptedCurrencies.includes(currency) ? "" : " · enable in Workspace first"}</option>)}</select><small>Provider verification checks this currency and the exact converted amount. A disabled Workspace currency cannot be saved or restored.</small></label>
        <label className="field"><span>POS order</span><input name="sortOrder" type="number" min="0" max="999" step="1" defaultValue={selected?.sortOrder ?? 100} required /></label>
        <label className="check-row"><input type="checkbox" name="referenceRequired" defaultChecked={selected?.referenceRequired} /><span><strong>Require a transaction reference</strong><small>Checkout remains locked until staff enter an approval, cheque or wallet reference.</small></span></label>
        <footer><button type="button" className="button button-secondary" onClick={closeMethod}>Cancel</button><button className="button button-primary" disabled={busy || !accounts.length}>{busy ? "Saving…" : restoring ? "Save & restore" : "Save payment method"}</button></footer>
      </form>
    </Modal>
  </div>;
}
