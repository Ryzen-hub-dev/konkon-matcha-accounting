"use client";

import type { CSSProperties } from "react";
import { Leaf } from "lucide-react";
import { shortDate } from "@/components/ui";
import { DEFAULT_INVOICE_TEMPLATE, type InvoiceTemplateInput } from "@/lib/invoice-templates";

export type InvoicePaperItem = {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type InvoicePaperDocument = {
  invoiceNo: string;
  status?: string;
  createdAt: string | Date;
  dueDate: string | Date;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  customerReference?: string;
  items: InvoicePaperItem[];
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  notes?: string;
  businessSnapshot?: {
    businessName?: string;
    registrationNo?: string;
    email?: string;
    phone?: string;
    address?: string;
    currency?: string;
    taxName?: string;
  };
};

export function InvoicePaper({ document, template = DEFAULT_INVOICE_TEMPLATE, compact = false }: {
  document: InvoicePaperDocument;
  template?: InvoiceTemplateInput;
  compact?: boolean;
}) {
  const business = document.businessSnapshot || {};
  const paperStyle = { "--invoice-accent": template.accentColor } as CSSProperties;
  const currency = /^[A-Z]{3}$/.test(business.currency || "") ? business.currency! : "SGD";
  const money = new Intl.NumberFormat("en-SG", { style: "currency", currency });
  return (
    <article className={`invoice-paper invoice-layout-${template.layout.toLowerCase()} invoice-tone-${template.paperTone.toLowerCase()} ${compact ? "invoice-paper-compact" : ""}`} style={paperStyle}>
      <header className="invoice-paper-header">
        <div className="invoice-paper-brand">
          {template.logoDataUrl ? <img src={template.logoDataUrl} alt={`${business.businessName || "Business"} logo`} /> : <span className="invoice-paper-mark"><Leaf size={18} /></span>}
          <div><small>{template.headerText}</small><strong>{business.businessName || "Kōn-Kōn Matchā"}</strong></div>
        </div>
        <div className="invoice-paper-title"><small>{document.status || "DRAFT"}</small><h2>{template.documentTitle}</h2><span>{document.invoiceNo}</span></div>
      </header>

      <section className="invoice-paper-parties">
        <div><small>BILLED TO</small><strong>{document.customerName}</strong>{document.customerAddress ? <p>{document.customerAddress}</p> : null}<span>{[document.customerEmail, document.customerPhone].filter(Boolean).join(" · ")}</span></div>
        <dl><div><dt>Issued</dt><dd>{shortDate.format(new Date(document.createdAt))}</dd></div><div><dt>Due</dt><dd>{shortDate.format(new Date(document.dueDate))}</dd></div>{document.customerReference ? <div><dt>Reference</dt><dd>{document.customerReference}</dd></div> : null}</dl>
      </section>

      <div className="invoice-paper-lines">
        <div className="invoice-paper-line invoice-paper-line-head"><span>Description</span><span>Qty</span><span>Rate</span><span>Amount</span></div>
        {document.items.map((item, index) => <div className="invoice-paper-line" key={`${item.description}-${index}`}><strong>{item.description}</strong><span>{item.quantity}</span><span>{money.format(item.unitPrice)}</span><b>{money.format(item.lineTotal)}</b></div>)}
      </div>

      <section className="invoice-paper-summary">
        <div className="invoice-paper-message">
          {template.showNotes && document.notes ? <><small>NOTES</small><p>{document.notes}</p></> : null}
          {template.paymentInstructions ? <><small>PAYMENT</small><p>{template.paymentInstructions}</p></> : null}
        </div>
        <dl><div><dt>Subtotal</dt><dd>{money.format(document.subtotal)}</dd></div>{template.showTaxBreakdown ? <div><dt>{business.taxName || "Tax"} · {document.taxRate}%</dt><dd>{money.format(document.tax)}</dd></div> : null}<div className="invoice-paper-grand-total"><dt>Total</dt><dd>{money.format(document.total)}</dd></div></dl>
      </section>

      <footer className="invoice-paper-footer">
        <div><strong>{template.footerText}</strong><span>{[business.email, business.phone, business.address].filter(Boolean).join(" · ")}</span>{template.showRegistrationNo && business.registrationNo ? <small>Registration {business.registrationNo}</small> : null}</div>
        <div className="invoice-paper-seal"><Leaf size={13} /><span>KŌN<br />KŌN</span></div>
      </footer>
    </article>
  );
}
