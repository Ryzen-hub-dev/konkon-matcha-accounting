"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ClipboardList, Clock3, CopyCheck, Eye, FilePlus2, Pencil, Plus, Printer, Search, Send, Trash2, XCircle } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { dateKeyInTimeZone, formatCalendarDate, shiftDateKey } from "@/lib/dates";
import { currencyFractionDigits, roundCurrency } from "@/lib/international";
import { calculateTaxTotals } from "@/lib/tax";

type AccountChoice = { _id: string; memberNo: string; name: string; email: string; phone: string; creditTermsDays: number; creditHold: boolean };
type QuoteItem = { description: string; quantity: number; unitPrice: number; lineTotal?: number };
type Quotation = {
  _id: string; quotationNo: string; status: string; effectiveStatus: string; memberId?: string; memberNo?: string;
  customerName: string; customerEmail: string; customerPhone: string; customerAddress: string; customerReference: string;
  validUntil: string; notes: string; items: QuoteItem[]; subtotal: number; taxRate: number; taxMode: "EXCLUSIVE" | "INCLUSIVE";
  tax: number; total: number; createdAt: string; updatedAt: string; acceptanceNote?: string;
  convertedInvoiceId?: string; convertedInvoiceNo?: string;
  businessSnapshot: { businessName?: string; legalEntityName?: string; registrationNo?: string; email?: string; phone?: string; address?: string; currency: string; locale: string; taxName?: string; timeZone?: string };
};
type QuoteAction = "MARK_SENT" | "ACCEPT" | "REJECT" | "VOID" | "CONVERT";

export function QuotationsView({ canWrite }: { canWrite: boolean }) {
  const { profile } = useBusiness();
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [editor, setEditor] = useState<Quotation | "NEW" | null>(null);
  const [viewing, setViewing] = useState<Quotation | null>(null);
  const [pending, setPending] = useState<{ quotation: Quotation; action: QuoteAction } | null>(null);
  const [note, setNote] = useState("");
  const [dueDate, setDueDate] = useState(shiftDateKey(dateKeyInTimeZone(new Date(), profile.timeZone), 14));
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try {
      const [quoteData, accountData] = await Promise.all([
        apiRequest<Quotation[]>("/api/quotations"),
        apiRequest<{ accounts: AccountChoice[] }>("/api/customer-accounts"),
      ]);
      setQuotations(quoteData); setAccounts(accountData.accounts);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load quotations.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function beginAction(quotation: Quotation, action: QuoteAction) {
    setNote("");
    const account = accounts.find(item => item._id === quotation.memberId);
    setDueDate(shiftDateKey(dateKeyInTimeZone(new Date(), profile.timeZone), account?.creditTermsDays ?? 14));
    setPending({ quotation, action });
  }

  async function confirmAction() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const updated = await apiRequest<Quotation>("/api/quotations", {
        method: "PATCH",
        body: JSON.stringify({
          id: pending.quotation._id, action: pending.action,
          expectedUpdatedAt: pending.quotation.updatedAt,
          note, ...(pending.action === "CONVERT" ? { dueDate } : {}),
        }),
      });
      const message = pending.action === "CONVERT" ? `${updated.quotationNo} converted to ${updated.convertedInvoiceNo}.`
        : pending.action === "ACCEPT" ? "Customer acceptance recorded."
        : pending.action === "MARK_SENT" ? "Quotation marked as sent. No email was sent by the system."
        : `Quotation marked ${pending.action.toLowerCase()}.`;
      show(message); setPending(null); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not update the quotation.", "error"); }
    finally { setBusy(false); }
  }

  const needle = search.trim().toLocaleLowerCase();
  const visible = quotations.filter(quotation => (filter === "ALL" || quotation.effectiveStatus === filter) && [quotation.quotationNo, quotation.customerName, quotation.customerEmail, quotation.customerReference].join(" ").toLocaleLowerCase().includes(needle));
  const baseQuotes = quotations.filter(quotation => quotation.businessSnapshot.currency === profile.currency);
  const quotedValue = baseQuotes.filter(quotation => ["DRAFT", "SENT", "ACCEPTED"].includes(quotation.effectiveStatus)).reduce((sum, quotation) => sum + quotation.total, 0);
  const formatter = (quotation: Quotation) => new Intl.NumberFormat(quotation.businessSnapshot.locale || profile.locale, { style: "currency", currency: quotation.businessSnapshot.currency || profile.currency });

  return <div className="page page-enter quotation-page">
    <PageHeader eyebrow="CUSTOMER SALES" title="Quotations" description="Prepare a controlled offer, record the customer's decision, and convert an accepted quote into one invoice draft." action={canWrite ? <AddButton onClick={() => setEditor("NEW")}>New quotation</AddButton> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row quotation-stats"><article><ClipboardList /><span>Open quotations</span><strong>{quotations.filter(item => ["DRAFT", "SENT", "ACCEPTED"].includes(item.effectiveStatus)).length}</strong></article><article><CheckCircle2 /><span>Accepted</span><strong>{quotations.filter(item => item.status === "ACCEPTED").length}</strong></article><article><CopyCheck /><span>Active quoted value</span><strong>{new Intl.NumberFormat(profile.locale, { style: "currency", currency: profile.currency }).format(quotedValue)}</strong></article></section>
    <section className="panel quotation-policy"><Send /><div><strong>Recording “sent” or “accepted” is an internal control, not an electronic signature.</strong><p>The system does not email the customer. Accepted quotations convert once to an editable invoice draft; invoice credit checks still run later when that draft is sent.</p></div></section>
    <section className="panel resource-panel quotation-register">
      <div className="quotation-toolbar"><label className="field"><span><Search size={14} />Search quotations</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Quotation, customer, email or reference" /></label><label className="field"><span>Status</span><select value={filter} onChange={event => setFilter(event.target.value)}>{["ALL", "DRAFT", "SENT", "EXPIRED", "ACCEPTED", "REJECTED", "CONVERTED", "VOID"].map(value => <option key={value} value={value}>{value === "ALL" ? "All statuses" : value}</option>)}</select></label><button className="button button-secondary" disabled={loading} onClick={load}>Refresh</button></div>
      {loading ? <LoadingPanel label="Preparing quotations…" /> : visible.length ? <div className="data-list quotation-list"><div className="data-list-head"><span>Quotation</span><span>Customer</span><span>Valid until</span><span>Value</span><span>Status</span><span>Actions</span></div>{visible.map(quotation => <div className="data-row" key={quotation._id}>
        <div><strong>{quotation.quotationNo}</strong><small>{new Intl.DateTimeFormat(profile.locale, { day: "2-digit", month: "short", year: "numeric", timeZone: profile.timeZone }).format(new Date(quotation.createdAt))}{quotation.memberNo ? ` · ${quotation.memberNo}` : ""}</small></div>
        <div><strong>{quotation.customerName}</strong><small>{quotation.customerEmail || quotation.customerReference || "No customer reference"}</small></div>
        <div><strong>{formatCalendarDate(quotation.validUntil, profile.locale)}</strong><small>{quotation.effectiveStatus === "EXPIRED" ? "Revision required" : "Saved calendar date"}</small></div>
        <strong>{formatter(quotation).format(quotation.total)}</strong><StatusPill value={quotation.effectiveStatus} />
        <div className="row-actions"><button className="button button-quiet" onClick={() => setViewing(quotation)}><Eye size={14} />View</button>{canWrite && quotation.status === "DRAFT" ? <><button className="button button-quiet" onClick={() => setEditor(quotation)}><Pencil size={14} />Edit</button><button className="button button-secondary" onClick={() => beginAction(quotation, "MARK_SENT")}><Send size={14} />Sent</button></> : null}{canWrite && quotation.status === "SENT" && quotation.effectiveStatus !== "EXPIRED" ? <button className="button button-primary" onClick={() => beginAction(quotation, "ACCEPT")}><CheckCircle2 size={14} />Accept</button> : null}{canWrite && quotation.status === "SENT" ? <button className="button button-quiet" onClick={() => beginAction(quotation, "REJECT")}><XCircle size={14} />Reject</button> : null}{canWrite && quotation.status === "ACCEPTED" ? <button className="button button-primary" onClick={() => beginAction(quotation, "CONVERT")}><FilePlus2 size={14} />Invoice</button> : null}{canWrite && ["DRAFT", "SENT", "ACCEPTED"].includes(quotation.status) ? <button className="button button-quiet" onClick={() => beginAction(quotation, "VOID")}>Void</button> : null}{quotation.convertedInvoiceId ? <Link className="button button-secondary" href={`/invoices/${quotation.convertedInvoiceId}`}>{quotation.convertedInvoiceNo}</Link> : null}</div>
      </div>)}</div> : <EmptyState title={quotations.length ? "No matching quotation" : "No quotations yet"} detail={quotations.length ? "Change the search or status filter." : "Prepare the first controlled customer offer."} action={canWrite && !quotations.length ? <AddButton onClick={() => setEditor("NEW")}>New quotation</AddButton> : undefined} />}
    </section>

    {editor ? <QuotationEditor source={editor === "NEW" ? undefined : editor} accounts={accounts} onClose={() => setEditor(null)} onSaved={quotation => { show(`${quotation.quotationNo} saved.`); setEditor(null); void load(); }} /> : null}

    <Modal open={Boolean(pending)} onClose={() => { if (!busy) setPending(null); }} title={actionTitle(pending?.action)} kicker={pending?.quotation.quotationNo}>
      {pending ? <div className="modal-form quotation-action-form"><p className="form-hint">{actionHelp(pending.action)}</p>{["ACCEPT", "REJECT", "VOID"].includes(pending.action) ? <label className="field"><span>{pending.action === "ACCEPT" ? "How customer acceptance was confirmed" : "Reason"}</span><textarea value={note} onChange={event => setNote(event.target.value)} minLength={3} maxLength={300} rows={3} required /></label> : null}{pending.action === "CONVERT" ? <label className="field"><span>New invoice due date</span><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></label> : null}<footer><button className="button button-secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button className="button button-primary" disabled={busy || (["ACCEPT", "REJECT", "VOID"].includes(pending.action) && note.trim().length < 3)} onClick={confirmAction}>{busy ? "Saving…" : "Confirm"}</button></footer></div> : null}
    </Modal>

    <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing ? `Quotation ${viewing.quotationNo}` : "Quotation"} kicker={viewing?.effectiveStatus}>
      {viewing ? <QuotationDocument quotation={viewing} /> : null}
    </Modal>
  </div>;
}

function actionTitle(action?: QuoteAction) {
  return action === "MARK_SENT" ? "Mark quotation as sent?" : action === "ACCEPT" ? "Record customer acceptance?" : action === "REJECT" ? "Record rejection?" : action === "CONVERT" ? "Convert to invoice draft?" : "Void quotation?";
}
function actionHelp(action: QuoteAction) {
  if (action === "MARK_SENT") return "This locks the quotation. It records an operational status only; the system does not send an email.";
  if (action === "ACCEPT") return "Record only a decision actually communicated by the customer. This is not a digital signature or independent proof of acceptance.";
  if (action === "REJECT") return "The quotation remains in history and cannot be reopened.";
  if (action === "CONVERT") return "One invoice draft will be created with the agreed prices and tax snapshot. You can review it before sending.";
  return "The quotation remains in history but cannot be edited or converted.";
}

function QuotationEditor({ source, accounts, onClose, onSaved }: { source?: Quotation; accounts: AccountChoice[]; onClose: () => void; onSaved: (quotation: Quotation) => void }) {
  const { profile } = useBusiness();
  const editing = Boolean(source);
  const [memberId, setMemberId] = useState(source?.memberId || "");
  const [customer, setCustomer] = useState({ customerName: source?.customerName || "", customerEmail: source?.customerEmail || "", customerPhone: source?.customerPhone || "", customerAddress: source?.customerAddress || "", customerReference: source?.customerReference || "", notes: source?.notes || "" });
  const [items, setItems] = useState<QuoteItem[]>(source?.items.map(item => ({ description: item.description, quantity: item.quantity, unitPrice: item.unitPrice })) || [{ description: "", quantity: 1, unitPrice: 0 }]);
  const [validUntil, setValidUntil] = useState(source?.validUntil.slice(0, 10) || shiftDateKey(dateKeyInTimeZone(new Date(), profile.timeZone), 14));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const guard = useRef(false);
  const currency = source?.businessSnapshot.currency || profile.currency;
  const locale = source?.businessSnapshot.locale || profile.locale;
  const money = new Intl.NumberFormat(locale, { style: "currency", currency });
  const subtotal = roundCurrency(items.reduce((sum, item) => sum + roundCurrency(item.quantity * roundCurrency(item.unitPrice, currency), currency), 0), currency);
  const totals = calculateTaxTotals(subtotal, 0, source?.taxRate ?? profile.taxRate, source?.taxMode || profile.taxMode, currency);

  function chooseAccount(id: string) {
    setMemberId(id);
    const account = accounts.find(item => item._id === id);
    if (account) setCustomer(current => ({ ...current, customerName: account.name, customerEmail: account.email || "", customerPhone: account.phone || "" }));
  }
  function changeItem(index: number, patch: Partial<QuoteItem>) { setItems(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (guard.current) return;
    guard.current = true; setBusy(true); setError("");
    try {
      const quotation = await apiRequest<Quotation>("/api/quotations", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({ ...customer, memberId, validUntil, items: items.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })), ...(editing ? { action: "EDIT_DRAFT", id: source!._id, expectedUpdatedAt: source!.updatedAt } : { clientRequestId: requestId.current }) }),
      });
      onSaved(quotation);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the quotation."); }
    finally { guard.current = false; setBusy(false); }
  }

  return <Modal open onClose={() => { if (!busy) onClose(); }} title={editing ? "Edit quotation draft" : "New quotation"} kicker={source?.quotationNo || "CUSTOMER OFFER"}>
    <form className="modal-form wide-form quotation-editor" onSubmit={save}>{error ? <div className="invoice-form-error" role="alert">{error}</div> : null}<fieldset disabled={busy}>
      <div className="invoice-account-link"><label className="field"><span>Customer account · optional</span><select value={memberId} onChange={event => chooseAccount(event.target.value)}><option value="">Unlinked customer</option>{source?.memberId && !accounts.some(account => account._id === source.memberId) ? <option value={source.memberId}>{source.memberNo || "Saved customer account"} · unavailable</option> : null}{accounts.map(account => <option key={account._id} value={account._id}>{account.memberNo} · {account.name}{account.creditHold ? " · CREDIT HOLD" : ""}</option>)}</select></label><p>A quotation does not consume credit. If converted, credit is checked only when the resulting invoice is sent.</p></div>
      <div className="form-grid three">{([["customerName", "Customer", "text"], ["customerEmail", "Email · optional", "email"], ["customerPhone", "Phone · optional", "text"]] as const).map(([key, label, type]) => <label className="field" key={key}><span>{label}</span><input type={type} value={customer[key]} onChange={event => setCustomer({ ...customer, [key]: event.target.value })} minLength={key === "customerName" ? 2 : undefined} maxLength={key === "customerName" ? 120 : key === "customerEmail" ? 254 : 40} required={key === "customerName"} /></label>)}</div>
      <div className="form-grid two"><label className="field"><span>Customer reference · optional</span><input value={customer.customerReference} onChange={event => setCustomer({ ...customer, customerReference: event.target.value })} maxLength={80} /></label><label className="field"><span>Valid until</span><input type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} required /></label></div>
      <label className="field"><span>Customer address · optional</span><textarea value={customer.customerAddress} onChange={event => setCustomer({ ...customer, customerAddress: event.target.value })} maxLength={300} rows={2} /></label>
      <div className="invoice-draft-lines">{items.map((item, index) => <div className="invoice-draft-line" key={index}><label className="field invoice-line-description"><span>Item {index + 1} · description</span><input value={item.description} onChange={event => changeItem(index, { description: event.target.value })} minLength={2} maxLength={160} required /></label><label className="field"><span>Quantity</span><input type="number" value={item.quantity} onChange={event => changeItem(index, { quantity: Number(event.target.value) })} min="0.01" max="100000" step="0.01" required /></label><label className="field"><span>Unit price · {currency}</span><input type="number" value={item.unitPrice} onChange={event => changeItem(index, { unitPrice: Number(event.target.value) })} min="0" max="100000000" step={10 ** -currencyFractionDigits(currency)} required /></label><strong className="invoice-line-total">{money.format(roundCurrency(item.quantity * item.unitPrice, currency))}</strong><button type="button" className="icon-button" disabled={items.length === 1} onClick={() => setItems(current => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16} /></button></div>)}<button type="button" className="button button-quiet" disabled={items.length >= 50} onClick={() => setItems(current => [...current, { description: "", quantity: 1, unitPrice: 0 }])}><Plus size={15} />Add item</button></div>
      <label className="field"><span>Customer-facing notes · optional</span><textarea value={customer.notes} onChange={event => setCustomer({ ...customer, notes: event.target.value })} maxLength={500} rows={3} /></label>
    </fieldset><dl className="invoice-draft-totals"><div><dt>Subtotal</dt><dd>{money.format(subtotal)}</dd></div><div><dt>{source?.businessSnapshot.taxName || profile.taxName} · {totals.taxRate}%</dt><dd>{money.format(totals.tax)}</dd></div><div><dt>Quotation total</dt><dd>{money.format(totals.total)}</dd></div></dl><footer><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}><FilePlus2 size={15} />{busy ? "Saving…" : editing ? "Save changes" : "Create quotation"}</button></footer></form>
  </Modal>;
}

function QuotationDocument({ quotation }: { quotation: Quotation }) {
  const money = new Intl.NumberFormat(quotation.businessSnapshot.locale || "en-MY", { style: "currency", currency: quotation.businessSnapshot.currency });
  return <div className="quotation-document"><header><div><span>QUOTATION</span><strong>{quotation.businessSnapshot.businessName}</strong><small>{quotation.businessSnapshot.address}</small></div><div><b>{quotation.quotationNo}</b><small>Valid until {formatCalendarDate(quotation.validUntil, quotation.businessSnapshot.locale)}</small><StatusPill value={quotation.effectiveStatus} /></div></header><section><div><small>PREPARED FOR</small><strong>{quotation.customerName}</strong><span>{[quotation.customerEmail, quotation.customerPhone, quotation.customerAddress].filter(Boolean).join(" · ")}</span></div><button className="button button-secondary quotation-print" onClick={() => window.print()}><Printer size={14} />Print</button></section><div className="report-table-wrap"><table className="report-table quotation-document-table"><thead><tr><th>Description</th><th className="number">Quantity</th><th className="number">Unit price</th><th className="number">Amount</th></tr></thead><tbody>{quotation.items.map((item, index) => <tr key={index}><td>{item.description}</td><td className="number">{item.quantity}</td><td className="number">{money.format(item.unitPrice)}</td><td className="number">{money.format(item.lineTotal ?? item.quantity * item.unitPrice)}</td></tr>)}</tbody><tfoot><tr><th colSpan={3}>Total including {quotation.businessSnapshot.taxName || "tax"} {quotation.taxRate}%</th><th className="number">{money.format(quotation.total)}</th></tr></tfoot></table></div>{quotation.notes ? <aside><small>NOTES</small><p>{quotation.notes}</p></aside> : null}<footer>This document is a quotation, not an invoice, payment receipt, electronic signature or proof of customer acceptance.</footer></div>;
}
