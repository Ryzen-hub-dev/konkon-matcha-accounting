"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { CircleDollarSign, Clock3, Eye, FilePlus2, FileText, Palette, Plus, Trash2 } from "lucide-react";
import { InvoiceTemplateStudio } from "@/components/invoice-template-studio";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, money, Notice, PageHeader, shortDate, StatusPill, useNotice } from "@/components/ui";
import type { InvoiceTemplateRecord } from "@/lib/invoice-templates";

type InvoiceItem = { description: string; quantity: number; unitPrice: number };
type Invoice = {
  _id: string;
  invoiceNo: string;
  customerName: string;
  customerEmail: string;
  dueDate: string;
  total: number;
  paidAmount: number;
  status: string;
  templateName?: string;
  createdAt: string;
};

function dueDateFrom(days: number) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

export function InvoicesView() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [templates, setTemplates] = useState<InvoiceTemplateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [dueDate, setDueDate] = useState(dueDateFrom(14));
  const [items, setItems] = useState<InvoiceItem[]>([{ description: "", quantity: 1, unitPrice: 0 }]);
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try {
      const [invoiceData, templateData] = await Promise.all([
        apiRequest<Invoice[]>("/api/invoices"),
        apiRequest<InvoiceTemplateRecord[]>("/api/invoice-templates"),
      ]);
      setInvoices(invoiceData);
      setTemplates(templateData);
      const preferred = templateData.find((template) => template.isDefault) || templateData[0];
      if (preferred && !selectedTemplateId) {
        setSelectedTemplateId(preferred._id);
        setDueDate(dueDateFrom(preferred.termsDays));
      }
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load invoices.", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function beginInvoice() {
    const preferred = templates.find((template) => template.isDefault) || templates[0];
    if (preferred) {
      setSelectedTemplateId(preferred._id);
      setDueDate(dueDateFrom(preferred.termsDays));
    }
    setOpen(true);
  }

  const outstanding = invoices.filter((invoice) => ["DRAFT", "SENT"].includes(invoice.status)).reduce((sum, invoice) => sum + invoice.total - invoice.paidAmount, 0);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/invoices", {
        method: "POST",
        body: JSON.stringify({
          customerName: data.get("customerName"), customerEmail: data.get("customerEmail"),
          customerPhone: data.get("customerPhone"), customerAddress: data.get("customerAddress"),
          customerReference: data.get("customerReference"), dueDate, notes: data.get("notes"),
          templateId: selectedTemplateId, items,
        }),
      });
      show("Invoice draft created with its template snapshot.");
      setOpen(false);
      setItems([{ description: "", quantity: 1, unitPrice: 0 }]);
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not create invoice.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    try {
      await apiRequest("/api/invoices", { method: "PATCH", body: JSON.stringify({ id, status }) });
      show(`Invoice marked ${status.toLocaleLowerCase()}.`);
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not update invoice.", "error");
    }
  }

  const draftTotal = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const selectedTemplate = templates.find((template) => template._id === selectedTemplateId);
  function updateItem(index: number, patch: Partial<InvoiceItem>) { setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }

  return <div className="page page-enter">
    <PageHeader eyebrow="ACCOUNTS RECEIVABLE" title="Invoices" description="Shape the paper, issue the account, and keep every historical invoice exactly as it was sent." action={<div className="invoice-page-actions"><button className="button button-secondary" onClick={() => setStudioOpen(true)}><Palette size={17} />Template studio</button><AddButton onClick={beginInvoice}>New invoice</AddButton></div>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><FileText /><span>Total invoices</span><strong>{invoices.length}</strong></article><article><Clock3 /><span>Outstanding</span><strong>{money.format(outstanding)}</strong></article><article><CircleDollarSign /><span>Paid</span><strong>{money.format(invoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0))}</strong></article></section>
    <section className="invoice-template-ribbon"><div><Palette size={18} /><span><strong>{templates.length || "—"} paper style{templates.length === 1 ? "" : "s"}</strong><small>JSON import, logo upload and print-safe layouts</small></span></div><div>{templates.slice(0, 5).map((template) => <button key={template._id} onClick={() => { setSelectedTemplateId(template._id); setStudioOpen(true); }}><i style={{ background: template.accentColor }} /><span>{template.name}</span>{template.isDefault ? <small>DEFAULT</small> : null}</button>)}</div></section>
    <section className="panel resource-panel">{loading ? <LoadingPanel /> : invoices.length ? <div className="data-list invoice-list"><div className="data-list-head"><span>Invoice</span><span>Customer</span><span>Due</span><span>Amount</span><span>Status</span><span>Action</span></div>{invoices.map((invoice) => <div className="data-row" key={invoice._id}><div><strong>{invoice.invoiceNo}</strong><small>{invoice.templateName || "Ceremonial paper"} · {shortDate.format(new Date(invoice.createdAt))}</small></div><div><strong>{invoice.customerName}</strong><small>{invoice.customerEmail || "No email"}</small></div><span>{shortDate.format(new Date(invoice.dueDate))}</span><strong>{money.format(invoice.total)}</strong><StatusPill value={invoice.status} /><div className="invoice-row-actions"><Link className="button button-quiet" href={`/invoices/${invoice._id}`}><Eye size={14} />View</Link><select className="status-select" value={invoice.status} disabled={invoice.status === "VOID"} onChange={(event) => setStatus(invoice._id, event.target.value)}><option>DRAFT</option><option>SENT</option><option>PAID</option><option>VOID</option></select></div></div>)}</div> : <EmptyState title="No invoices drafted" detail="Create a branded invoice for wholesale, events or other account sales." action={<AddButton onClick={beginInvoice}>New invoice</AddButton>} />}</section>

    <Modal open={open} onClose={() => setOpen(false)} title="Create invoice" kicker="NEW RECEIVABLE"><form className="modal-form wide-form" onSubmit={create}><div className="form-grid three"><label className="field"><span>Customer</span><input name="customerName" required autoFocus /></label><label className="field"><span>Email · optional</span><input name="customerEmail" type="email" /></label><label className="field"><span>Phone · optional</span><input name="customerPhone" /></label></div><div className="form-grid three"><label className="field"><span>Customer reference</span><input name="customerReference" placeholder="PO number or event" /></label><label className="field"><span>Due date</span><input name="dueDate" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label><label className="field"><span>Paper template</span><select value={selectedTemplateId} onChange={(event) => { const id = event.target.value; setSelectedTemplateId(id); const template = templates.find((item) => item._id === id); if (template) setDueDate(dueDateFrom(template.termsDays)); }} required><option value="">Choose template</option>{templates.map((template) => <option key={template._id} value={template._id}>{template.name}{template.isDefault ? " · default" : ""}</option>)}</select></label></div><label className="field"><span>Billing address · optional</span><textarea name="customerAddress" rows={2} /></label>{selectedTemplate ? <div className="selected-template-note"><i style={{ background: selectedTemplate.accentColor }} /><span><strong>{selectedTemplate.name}</strong><small>{selectedTemplate.layout.toLocaleLowerCase()} paper · due in {selectedTemplate.termsDays} days</small></span><button type="button" onClick={() => { setOpen(false); setStudioOpen(true); }}>Edit template</button></div> : null}<div className="invoice-editor"><div className="invoice-editor-head"><span>Description</span><span>Qty</span><span>Unit price</span><span>Total</span><span /></div>{items.map((item, index) => <div className="invoice-editor-line" key={index}><input value={item.description} onChange={(event) => updateItem(index, { description: event.target.value })} placeholder="Product or service" required /><input type="number" min="0.01" step="0.01" value={item.quantity} onChange={(event) => updateItem(index, { quantity: Number(event.target.value) })} required /><input type="number" min="0" step="0.01" value={item.unitPrice || ""} onChange={(event) => updateItem(index, { unitPrice: Number(event.target.value) })} placeholder="0.00" required /><strong>{money.format(item.quantity * item.unitPrice)}</strong><button type="button" disabled={items.length === 1} onClick={() => setItems((current) => current.filter((_, i) => i !== index))}><Trash2 size={15} /></button></div>)}<button type="button" className="add-line" onClick={() => setItems((current) => [...current, { description: "", quantity: 1, unitPrice: 0 }])}><Plus size={15} />Add item</button></div><label className="field"><span>Customer-facing notes · optional</span><textarea name="notes" rows={3} /></label><div className="invoice-total"><span>Subtotal · workspace tax is added on save</span><strong>{money.format(draftTotal)}</strong></div><footer><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="button button-primary" disabled={!draftTotal || !selectedTemplateId || busy}><FilePlus2 size={16} />{busy ? "Creating…" : "Create draft"}</button></footer></form></Modal>
    <InvoiceTemplateStudio open={studioOpen} templates={templates} initialTemplateId={selectedTemplateId} onClose={() => setStudioOpen(false)} onChanged={load} />
  </div>;
}
