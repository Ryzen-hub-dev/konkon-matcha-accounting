"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { FilePlus2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { ApiRequestError, apiRequest, Modal } from "@/components/ui";
import { useBusiness } from "@/components/business-context";
import { dateKeyInTimeZone, shiftDateKey } from "@/lib/dates";
import { currencyFractionDigits, roundCurrency } from "@/lib/international";
import { calculateTaxTotals } from "@/lib/tax";
import type { InvoiceTemplateRecord } from "@/lib/invoice-templates";

type Customer = { customerName: string; customerEmail: string; customerPhone: string; customerAddress: string; customerReference: string; notes: string };
type Item = { description: string; quantity: number; unitPrice: number };
type CustomerAccountChoice = {
  _id: string; memberNo: string; name: string; email: string; phone: string;
  creditLimit: number | null; creditTermsDays: number; creditHold: boolean; outstanding: number; availableCredit: number | null;
};
export type EditableInvoice = Customer & {
  _id: string; invoiceNo: string; dueDate: string; createdAt: string; updatedAt: string;
  items: Item[]; total: number; paidAmount: number; status: string; taxRate: number; taxMode?: "EXCLUSIVE" | "INCLUSIVE";
  memberId?: string; memberNo?: string; templateId?: string; templateName?: string; businessSnapshot?: { currency?: string; locale?: string; taxName?: string };
};
const empty: Customer = { customerName: "", customerEmail: "", customerPhone: "", customerAddress: "", customerReference: "", notes: "" };

export function InvoiceDraftEditor({ source, mode, templates, onClose, onSaved }: {
  source?: EditableInvoice; mode: "NEW" | "EDIT" | "COPY"; templates: InvoiceTemplateRecord[];
  onClose: () => void; onSaved: (invoice: EditableInvoice) => void;
}) {
  const { profile } = useBusiness();
  const editing = mode === "EDIT";
  const preferred = templates.find(template => template._id === source?.templateId) || templates.find(template => template.isDefault) || templates[0];
  const [customer, setCustomer] = useState<Customer>(() => source ? Object.fromEntries(Object.keys(empty).map(key => [key, source[key as keyof Customer] || ""])) as Customer : { ...empty });
  const [memberId, setMemberId] = useState(source?.memberId || "");
  const [accounts, setAccounts] = useState<CustomerAccountChoice[]>([]);
  const [items, setItems] = useState<Item[]>(() => source ? source.items.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })) : [{ description: "", quantity: 1, unitPrice: 0 }]);
  const [dueDate, setDueDate] = useState(() => editing && source ? source.dueDate.slice(0, 10) : shiftDateKey(dateKeyInTimeZone(new Date(), profile.timeZone), preferred?.termsDays ?? 14));
  const [templateId, setTemplateId] = useState(editing ? source?.templateId || "" : preferred?._id || "");
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const requestId = useRef("");
  const retry = useRef<string | null>(null);
  const currency = (editing && source?.businessSnapshot?.currency) || profile.currency;
  const locale = (editing && source?.businessSnapshot?.locale) || profile.locale;
  const money = new Intl.NumberFormat(locale, { style: "currency", currency });
  const round = (value: number) => roundCurrency(value, currency);
  const subtotal = round(items.reduce((sum, item) => sum + round(item.quantity * round(item.unitPrice)), 0));
  const totals = calculateTaxTotals(subtotal, 0, editing ? source!.taxRate : profile.taxRate, editing ? source!.taxMode || "EXCLUSIVE" : profile.taxMode, currency);
  const selectedAccount = accounts.find(account => account._id === memberId);

  useEffect(() => {
    void apiRequest<{ accounts: CustomerAccountChoice[] }>("/api/customer-accounts")
      .then(result => setAccounts(result.accounts))
      .catch(() => undefined);
  }, []);

  function chooseAccount(id: string) {
    setMemberId(id);
    setDirty(true);
    const account = accounts.find(item => item._id === id);
    if (!account) return;
    setCustomer(current => ({ ...current, customerName: account.name, customerEmail: account.email || "", customerPhone: account.phone || "" }));
    if (!editing) setDueDate(shiftDateKey(dateKeyInTimeZone(new Date(), profile.timeZone), account.creditTermsDays));
  }

  function close() {
    if (guard.current) return;
    if ((dirty || uncertain) && !window.confirm(uncertain ? "The save may have succeeded. Close and refresh the invoice list before creating another draft?" : "Discard your unsaved invoice changes?")) return;
    onClose();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (guard.current) return;
    guard.current = true; setBusy(true); setError("");
    requestId.current ||= crypto.randomUUID();
    const payload = retry.current || JSON.stringify({ ...customer, memberId, items, dueDate, templateId, ...(editing ? { action: "EDIT_DRAFT", id: source!._id, expectedUpdatedAt: source!.updatedAt } : { clientRequestId: requestId.current }) });
    try {
      const saved = await apiRequest<EditableInvoice>("/api/invoices", { method: editing ? "PATCH" : "POST", body: payload });
      onSaved(saved);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not save invoice.";
      if (!editing && reason instanceof ApiRequestError && (reason.status === 0 || reason.status >= 500)) {
        retry.current = payload; setUncertain(true);
        setError(`${message} The result is uncertain. Retry the same request safely before changing these details.`);
      } else setError(reason instanceof ApiRequestError && reason.status === 409 ? `${message} Your changes are still here. Copy any notes you need, then cancel and reopen the invoice to load its latest version.` : message);
    } finally { guard.current = false; setBusy(false); }
  }
  function changeItem(index: number, patch: Partial<Item>) { setDirty(true); setItems(current => current.map((item, i) => i === index ? { ...item, ...patch } : item)); }

  return <Modal open onClose={close} title={editing ? "Edit invoice draft" : mode === "COPY" ? "Copy as new draft" : "Create invoice"} kicker={source?.invoiceNo || "NEW RECEIVABLE"}>
    <form className="modal-form wide-form invoice-draft-form" onSubmit={save} onChange={() => setDirty(true)}>
      <div className="invoice-draft-guidance"><ShieldCheck size={18} /><p>{editing ? `The original ${currency} currency, tax treatment and business details stay unchanged. The saved paper style is preserved unless you choose another template.` : mode === "COPY" ? "Review the copied customer reference and prices, current tax settings and new due date. The original invoice will not change." : "Review the customer, prices and tax total. You can edit this draft until it is marked sent or paid."}</p></div>
      {error ? <div className="invoice-form-error" role="alert">{error}</div> : null}
      <fieldset disabled={busy || uncertain}>
        <div className={`invoice-account-link ${selectedAccount?.creditHold ? "is-held" : ""}`}><label className="field"><span>Customer account · optional</span><select value={memberId} onChange={event => chooseAccount(event.target.value)}><option value="">Unlinked invoice customer</option>{source?.memberId && !accounts.some(account => account._id === source.memberId) ? <option value={source.memberId}>{source.memberNo || "Saved customer account"} · unavailable</option> : null}{accounts.map(account => <option key={account._id} value={account._id}>{account.memberNo} · {account.name}{account.creditHold ? " · CREDIT HOLD" : ""}</option>)}</select></label><p>{selectedAccount ? selectedAccount.creditHold ? "This account is on hold. The draft can be saved, but it cannot be marked sent until the hold is removed." : selectedAccount.creditLimit === null ? `${selectedAccount.creditTermsDays} day terms · no configured credit ceiling.` : `${selectedAccount.creditTermsDays} day terms · ${money.format(selectedAccount.availableCredit || 0)} credit available.` : "Link a member account to enforce credit controls and include this invoice on its statement."}</p></div>
        <div className="form-grid three">{([["customerName", "Customer", "text", 120], ["customerEmail", "Email · optional", "email", 254], ["customerPhone", "Phone · optional", "text", 40]] as const).map(([key, label, type, max]) => <label key={key} className="field"><span>{label}</span><input name={key} type={type} minLength={key === "customerName" ? 2 : undefined} maxLength={max} required={key === "customerName"} autoFocus={key === "customerName"} value={customer[key]} onChange={event => setCustomer({ ...customer, [key]: event.target.value })} /></label>)}</div>
        <div className="form-grid three"><label className="field"><span>Customer reference</span><input name="customerReference" maxLength={80} placeholder="PO number or event" value={customer.customerReference} onChange={event => setCustomer({ ...customer, customerReference: event.target.value })} /></label><label className="field"><span>Due date</span><input name="dueDate" type="date" required value={dueDate} onChange={event => setDueDate(event.target.value)} /></label><label className="field"><span>Paper template</span><select value={templateId} onChange={event => setTemplateId(event.target.value)} required={!editing}><option value="">{editing ? "Keep saved paper" : "Choose template"}</option>{editing && source?.templateId && !templates.some(template => template._id === source.templateId) ? <option value={source.templateId}>{source.templateName} · saved snapshot</option> : null}{templates.map(template => <option key={template._id} value={template._id}>{template.name}{editing && template._id === source?.templateId ? " · saved snapshot" : template.isDefault ? " · default" : ""}</option>)}</select></label></div>
        <label className="field"><span>Billing address · optional</span><textarea name="customerAddress" maxLength={300} rows={2} value={customer.customerAddress} onChange={event => setCustomer({ ...customer, customerAddress: event.target.value })} /></label>
        <div className="invoice-draft-lines">{items.map((item, index) => <div className="invoice-draft-line" key={index}>
          <label className="field invoice-line-description"><span>Item {index + 1} · description</span><input aria-label={`Item ${index + 1} description`} minLength={2} maxLength={160} required value={item.description} onChange={event => changeItem(index, { description: event.target.value })} placeholder="Product or service" /></label>
          <label className="field"><span>Quantity</span><input aria-label={`Item ${index + 1} quantity`} type="number" min="0.01" max="100000" step="0.01" required value={item.quantity} onChange={event => changeItem(index, { quantity: Number(event.target.value) })} /></label>
          <label className="field"><span>Unit price · {currency}</span><input aria-label={`Item ${index + 1} unit price`} type="number" min="0" max="100000000" step={10 ** -currencyFractionDigits(currency)} required value={item.unitPrice} onChange={event => changeItem(index, { unitPrice: Number(event.target.value) })} /></label>
          <strong className="invoice-line-total">{money.format(round(item.quantity * round(item.unitPrice)))}</strong><button type="button" className="icon-button" aria-label={`Remove item ${index + 1}`} disabled={items.length === 1} onClick={() => { setDirty(true); setItems(current => current.filter((_, i) => i !== index)); }}><Trash2 size={16} /></button>
        </div>)}<button type="button" className="button button-quiet" disabled={items.length >= 50} onClick={() => { setDirty(true); setItems(current => [...current, { description: "", quantity: 1, unitPrice: 0 }]); }}><Plus size={15} />Add item</button></div>
        <label className="field"><span>Customer-facing notes · optional</span><textarea name="notes" maxLength={500} rows={3} value={customer.notes} onChange={event => setCustomer({ ...customer, notes: event.target.value })} /></label>
      </fieldset>
      <dl className="invoice-draft-totals"><div><dt>Subtotal</dt><dd>{money.format(subtotal)}</dd></div><div><dt>{(editing && source?.businessSnapshot?.taxName) || profile.taxName} · {totals.taxRate}%{totals.taxMode === "INCLUSIVE" ? " included" : " added"}</dt><dd>{money.format(totals.tax)}</dd></div><div><dt>Invoice total</dt><dd>{money.format(totals.total)}</dd></div></dl>
      <footer><button type="button" className="button button-secondary" disabled={busy} onClick={close}>Cancel</button><button className="button button-primary" disabled={busy || (!editing && !templateId)}><FilePlus2 size={16} />{busy ? "Saving…" : uncertain ? "Retry same save" : editing ? "Save draft changes" : "Create draft"}</button></footer>
    </form>
  </Modal>;
}
