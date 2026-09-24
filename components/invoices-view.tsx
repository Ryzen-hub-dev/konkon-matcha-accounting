"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CalendarClock, CircleDollarSign, Clock3, Copy, Eye, FileText, Palette, Pencil, Search, ShieldCheck } from "lucide-react";
import { InvoiceTemplateStudio } from "@/components/invoice-template-studio";
import { InvoiceDraftEditor, type EditableInvoice } from "@/components/invoice-draft-editor";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { dateKeyInTimeZone, formatCalendarDate } from "@/lib/dates";
import { useBusiness } from "@/components/business-context";
import type { InvoiceTemplateRecord } from "@/lib/invoice-templates";

export function InvoicesView() {
  const { money, shortDate, profile } = useBusiness();
  const [invoices, setInvoices] = useState<EditableInvoice[]>([]);
  const [templates, setTemplates] = useState<InvoiceTemplateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<{ mode: "NEW" | "EDIT" | "COPY"; source?: EditableInvoice } | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [statusChange, setStatusChange] = useState<{ invoice: EditableInvoice; status: string } | null>(null);
  const [statusError, setStatusError] = useState("");
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try {
      const [invoiceData, templateData] = await Promise.all([apiRequest<EditableInvoice[]>("/api/invoices"), apiRequest<InvoiceTemplateRecord[]>("/api/invoice-templates")]);
      setInvoices(invoiceData); setTemplates(templateData);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load invoices.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function beginFrom(id: string, mode: "EDIT" | "COPY") {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const source = await apiRequest<EditableInvoice>("/api/invoices?id=" + id);
      if (mode === "EDIT" && (source.status !== "DRAFT" || source.paidAmount > 0)) throw new Error("Only unpaid drafts can be edited. Copy this invoice to prepare a new draft.");
      if (mode === "COPY" && source.businessSnapshot?.currency && source.businessSnapshot.currency !== profile.currency) throw new Error("This invoice uses a different currency. Create a new draft with reviewed prices; copying does not convert currencies.");
      setEditor({ mode, source });
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not open invoice.", "error"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function confirmStatus() {
    if (!statusChange || busyRef.current) return;
    busyRef.current = true; setBusy(true); setStatusError("");
    try {
      await apiRequest("/api/invoices", { method: "PATCH", body: JSON.stringify({ id: statusChange.invoice._id, status: statusChange.status, expectedUpdatedAt: statusChange.invoice.updatedAt }) });
      show("Invoice marked " + statusChange.status.toLowerCase() + "."); setStatusChange(null); await load();
    } catch (reason) { setStatusError(reason instanceof Error ? reason.message : "Could not update invoice. Close and refresh before trying again."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  const baseInvoices = invoices.filter(invoice => !invoice.businessSnapshot?.currency || invoice.businessSnapshot.currency === profile.currency);
  const outstanding = baseInvoices.filter(invoice => ["DRAFT", "SENT"].includes(invoice.status)).reduce((sum, invoice) => sum + invoice.total - invoice.paidAmount, 0);
  const today = dateKeyInTimeZone(new Date(), profile.timeZone);
  const overdue = (invoice: EditableInvoice) => invoice.status === "SENT" && invoice.paidAmount < invoice.total && invoice.dueDate.slice(0, 10) < today;
  const needle = search.trim().toLocaleLowerCase();
  const visible = invoices.filter(invoice => (filter === "ALL" || (filter === "OVERDUE" ? overdue(invoice) : invoice.status === filter)) && [invoice.invoiceNo, invoice.customerName, invoice.customerEmail, invoice.customerReference].join(" ").toLocaleLowerCase().includes(needle));
  const amount = (invoice: EditableInvoice) => new Intl.NumberFormat(invoice.businessSnapshot?.locale || profile.locale, { style: "currency", currency: invoice.businessSnapshot?.currency || profile.currency }).format(invoice.total);

  return <div className="page page-enter invoice-workspace">
    <PageHeader eyebrow="ACCOUNTS RECEIVABLE" title="Invoices" description="Prepare a draft, review the details, and preserve the paper you issue." action={<div className="invoice-page-actions"><Link className="button button-secondary" href="/invoices/recurring"><CalendarClock size={17} />Recurring</Link><button className="button button-secondary" onClick={() => setStudioOpen(true)}><Palette size={17} />Template studio</button><AddButton onClick={() => setEditor({ mode: "NEW" })}>New invoice</AddButton></div>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><FileText /><span>Loaded invoices</span><strong>{invoices.length}</strong></article><article><Clock3 /><span>Outstanding incl. drafts</span><strong>{money.format(outstanding)}</strong></article><article><CircleDollarSign /><span>Recorded payments</span><strong>{money.format(baseInvoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0))}</strong></article></section>
    <section className="invoice-template-ribbon"><div><ShieldCheck size={20} /><span><strong>Drafts can change. Issued documents stay intact.</strong><small>Edit an unpaid draft or copy an invoice into a new draft for review.</small></span></div><button className="button button-secondary invoice-paper-button" onClick={() => setStudioOpen(true)}><Palette size={16} />{templates.length} paper styles</button></section>
    <section className="panel resource-panel invoice-register">
      <div className="invoice-filterbar"><label className="field"><span><Search size={14} />Search loaded invoices</span><input type="search" placeholder="Invoice, customer, email or reference" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="field"><span>Status</span><select value={filter} onChange={event => setFilter(event.target.value)}>{["ALL", "DRAFT", "SENT", "OVERDUE", "PAID", "VOID"].map(status => <option key={status} value={status}>{status === "ALL" ? "All statuses" : status}</option>)}</select></label><button className="button button-secondary" disabled={loading} onClick={load}>Refresh</button></div>
      <p className="invoice-list-caption" role="status">Showing {visible.length} of {invoices.length} loaded invoices. Latest 200; summary amounts include {profile.currency} invoices only.</p>
      {loading ? <LoadingPanel /> : visible.length ? <div className="invoice-register-rows">{visible.map(invoice => <article className="invoice-register-row" key={invoice._id} data-invoice-id={invoice._id}>
        <div className="invoice-register-identity"><Link href={"/invoices/" + invoice._id}><strong>{invoice.invoiceNo}</strong></Link><small>{invoice.templateName || "Saved paper"} · {shortDate.format(new Date(invoice.createdAt))}</small></div>
        <div className="invoice-register-customer"><strong>{invoice.customerName}</strong><small>{invoice.customerEmail || invoice.customerReference || "No customer reference"}</small></div>
        <div className="invoice-register-value"><strong>{amount(invoice)}</strong><small>Due {formatCalendarDate(invoice.dueDate, profile.locale)}</small></div>
        <div className="invoice-register-status"><StatusPill value={overdue(invoice) ? "OVERDUE" : invoice.status} /></div>
        <div className="invoice-register-actions"><Link className="button button-quiet" href={"/invoices/" + invoice._id}><Eye size={14} />View</Link><button className="button button-quiet" disabled={busy} onClick={() => beginFrom(invoice._id, "COPY")}><Copy size={14} />Copy</button>{invoice.status === "DRAFT" ? <button className="button button-quiet" disabled={busy} onClick={() => beginFrom(invoice._id, "EDIT")}><Pencil size={14} />Edit</button> : null}
          {["DRAFT", "SENT"].includes(invoice.status) ? <select className="status-select" disabled={busy} aria-label={"Change status for " + invoice.invoiceNo} value="" onChange={event => { setStatusError(""); setStatusChange({ invoice, status: event.target.value }); }}><option value="" disabled>Change status…</option>{invoice.status === "DRAFT" ? <option value="SENT">Mark as sent</option> : null}<option value="PAID">Record full payment</option><option value="VOID">Void invoice</option></select> : null}</div>
      </article>)}</div> : <EmptyState title={invoices.length ? "No matching invoices" : "No invoices drafted"} detail={invoices.length ? "Change the search or status filter to find your invoice." : "Create a branded invoice for wholesale, events or account sales."} action={!invoices.length ? <AddButton onClick={() => setEditor({ mode: "NEW" })}>New invoice</AddButton> : undefined} />}
    </section>
    {editor ? <InvoiceDraftEditor mode={editor.mode} source={editor.source} templates={templates} onClose={() => { setEditor(null); void load(); }} onSaved={invoice => { show(invoice.invoiceNo + (editor.mode === "EDIT" ? " updated." : " created.")); setEditor(null); void load(); }} /> : null}
    <Modal open={Boolean(statusChange)} onClose={() => { if (!busyRef.current) setStatusChange(null); }} title={statusChange?.status === "PAID" ? "Record full payment?" : statusChange?.status === "VOID" ? "Void this invoice?" : "Mark invoice as sent?"} kicker={statusChange?.invoice.invoiceNo}>
      <div className="modal-form invoice-status-confirm">{statusError ? <Notice message={statusError} tone="error" /> : null}<p>{statusChange?.invoice.customerName} · {statusChange ? amount(statusChange.invoice) : ""}</p><p>{statusChange?.status === "PAID" ? "Only confirm money you have actually received. This records full payment to Bank (1010), posts the accounting entry, and locks the invoice." : statusChange?.status === "VOID" ? "The invoice stays in your history but is no longer outstanding. A void invoice cannot be reopened; you can copy it into a new draft." : "This records the sent status; it does not email the customer. Customer details and amounts will be locked. Use View to print or save your invoice."}</p><footer><button className="button button-secondary" disabled={busy} onClick={() => setStatusChange(null)}>Cancel</button><button className="button button-primary" disabled={busy} onClick={confirmStatus}>{busy ? "Saving…" : "Confirm status change"}</button></footer></div>
    </Modal>
    <InvoiceTemplateStudio open={studioOpen} templates={templates} onClose={() => setStudioOpen(false)} onChanged={load} />
  </div>;
}
