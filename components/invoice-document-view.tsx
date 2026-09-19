"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { InvoicePaper, type InvoicePaperDocument } from "@/components/invoice-paper";
import { apiRequest, EmptyState, LoadingPanel, Notice, useNotice } from "@/components/ui";
import { DEFAULT_INVOICE_TEMPLATE, type InvoiceTemplateInput } from "@/lib/invoice-templates";
import { EInvoiceGenerator } from "./e-invoice-generator";

type InvoiceDocument = InvoicePaperDocument & {
  _id: string;
  templateName?: string;
  templateSnapshot?: InvoiceTemplateInput;
  dimensionSelection?: { mode: string; costCentre?: { code: string; name: string }; project?: { code: string; name: string } };
};

export function InvoiceDocumentView({ id }: { id: string }) {
  const [invoice, setInvoice] = useState<InvoiceDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const { notice, show } = useNotice();

  useEffect(() => {
    apiRequest<InvoiceDocument>(`/api/invoices?id=${encodeURIComponent(id)}`)
      .then(setInvoice)
      .catch((reason) => show(reason instanceof Error ? reason.message : "Could not load the invoice.", "error"))
      .finally(() => setLoading(false));
  }, [id, show]);

  if (loading) return <div className="page"><LoadingPanel label="Preparing the invoice paper…" /></div>;
  if (!invoice) return <div className="page"><EmptyState title="Invoice unavailable" detail="Return to invoices and choose another document." action={<Link className="button button-secondary" href="/invoices">Back to invoices</Link>} /></div>;
  const template = { ...DEFAULT_INVOICE_TEMPLATE, ...(invoice.templateSnapshot || {}) };

  return <div className="page invoice-document-page page-enter">
    {notice ? <Notice {...notice} /> : null}
    <header className="invoice-document-toolbar"><div><Link className="button button-secondary" href="/invoices"><ArrowLeft size={16} />Invoices</Link><span><small>PAPER PROOF</small><strong>{invoice.invoiceNo}</strong></span></div><button className="button button-primary" onClick={() => window.print()}><Printer size={16} />Print or save PDF</button></header>
    <div className="document-toolbar no-print"><EInvoiceGenerator sourceId={id} sourceType="INVOICE" /><div className="invoice-dimension-chip"><small>INTERNAL CLASSIFICATION</small><strong>{[invoice.dimensionSelection?.costCentre?.code, invoice.dimensionSelection?.project?.code].filter(Boolean).join(" / ") || "Unassigned"}</strong><span>{invoice.dimensionSelection?.mode === "CUSTOM" ? "Document override" : invoice.dimensionSelection?.mode === "CUSTOMER_DEFAULT" ? "Customer account default" : invoice.dimensionSelection?.mode === "NONE" ? "Explicitly unassigned" : "Legacy invoice"}</span></div></div>
    <div className="invoice-document-stage"><InvoicePaper document={invoice} template={template} /></div>
  </div>;
}
