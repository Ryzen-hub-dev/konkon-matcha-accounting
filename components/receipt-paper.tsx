"use client";

import type { CSSProperties } from "react";
import { Leaf } from "lucide-react";
import { DEFAULT_RECEIPT_TEMPLATE, type ReceiptTemplateInput } from "@/lib/receipt-templates";

export type ReceiptPaperDocument = {
  _id?: string;
  receiptNo: string;
  status?: string;
  createdAt: string | Date;
  cashierName?: string;
  memberName?: string;
  memberNo?: string;
  pointsEarned?: number;
  pointsBalance?: number;
  items: Array<{ sku?: string; name: string; quantity: number; price: number; lineTotal: number }>;
  subtotal: number;
  discount: number;
  taxRate: number;
  taxMode?: "EXCLUSIVE" | "INCLUSIVE";
  tax: number;
  total: number;
  refundedAmount?: number;
  paymentMethod: string;
  paymentMethodName?: string;
  paymentKind?: "CASH" | "NON_CASH";
  paymentReference?: string;
  tenderedAmount?: number;
  changeDue?: number;
  saleNote?: string;
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

export function ReceiptPaper({ document, template = DEFAULT_RECEIPT_TEMPLATE, compact = false }: {
  document: ReceiptPaperDocument;
  template?: ReceiptTemplateInput;
  compact?: boolean;
}) {
  const business = document.businessSnapshot || {};
  const currency = /^[A-Z]{3}$/.test(business.currency || "") ? business.currency! : "SGD";
  const money = new Intl.NumberFormat("en-SG", { style: "currency", currency });
  const dateTime = new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const style = { "--receipt-accent": template.accentColor } as CSSProperties;
  const isCash = document.paymentKind ? document.paymentKind === "CASH" : document.paymentMethod === "CASH";

  return <article className={`thermal-receipt receipt-width-${template.paperWidth.toLowerCase()} receipt-density-${template.density.toLowerCase()} ${compact ? "thermal-receipt-compact" : ""}`} style={style}>
    <header className="receipt-paper-header">
      {template.logoDataUrl ? <img src={template.logoDataUrl} alt={`${business.businessName || "Business"} logo`} /> : <span className="receipt-leaf-mark"><Leaf size={18} /></span>}
      <strong>{business.businessName || "Kōn-Kōn Matchā"}</strong>
      {template.headerText ? <small>{template.headerText}</small> : null}
      {template.showBusinessAddress && business.address ? <p>{business.address}</p> : null}
      <span>{[business.phone, business.email].filter(Boolean).join(" · ")}</span>
      {template.showRegistrationNo && business.registrationNo ? <span>REG {business.registrationNo}</span> : null}
    </header>

    <section className="receipt-paper-title">
      <strong>{template.receiptTitle}</strong>
      <span>{document.receiptNo}</span>
      <time>{dateTime.format(new Date(document.createdAt))}</time>
    </section>
    {document.status && document.status !== "COMPLETED" ? <div className="receipt-refund-stamp"><strong>{document.status.replaceAll("_", " ")}</strong>{document.refundedAmount ? <span>{money.format(document.refundedAmount)} refunded</span> : null}</div> : null}

    {(template.showCashier || template.showMember) ? <dl className="receipt-paper-meta">
      {template.showCashier && document.cashierName ? <div><dt>Cashier</dt><dd>{document.cashierName}</dd></div> : null}
      {template.showMember && document.memberName ? <div><dt>Customer</dt><dd>{document.memberName}{document.memberNo ? ` · ${document.memberNo}` : ""}</dd></div> : null}
    </dl> : null}

    <div className="receipt-paper-items">
      {document.items.map((item, index) => <div className="receipt-paper-item" key={`${item.name}-${index}`}>
        <div><strong>{item.name}</strong>{template.showSku && item.sku ? <small>{item.sku}</small> : null}</div>
        <span>{item.quantity} × {money.format(item.price)}</span>
        <b>{money.format(item.lineTotal)}</b>
      </div>)}
    </div>

    <dl className="receipt-paper-totals">
      <div><dt>Subtotal</dt><dd>{money.format(document.subtotal)}</dd></div>
      {document.discount > 0 ? <div><dt>Discount</dt><dd>−{money.format(document.discount)}</dd></div> : null}
      {template.showTaxBreakdown ? <div><dt>{business.taxName || "Tax"} {document.taxRate}%{document.taxMode === "INCLUSIVE" ? " · included" : ""}</dt><dd>{money.format(document.tax)}</dd></div> : null}
      <div className="receipt-paper-grand"><dt>Total</dt><dd>{money.format(document.total)}</dd></div>
      {document.refundedAmount ? <><div><dt>Refunded</dt><dd>−{money.format(document.refundedAmount)}</dd></div><div><dt>Net retained</dt><dd>{money.format(Math.max(0, document.total - document.refundedAmount))}</dd></div></> : null}
    </dl>

    {template.showPaymentDetails ? <dl className="receipt-paper-payment">
      <div><dt>Paid by</dt><dd>{document.paymentMethodName || document.paymentMethod}</dd></div>
      {document.paymentReference ? <div><dt>Reference</dt><dd>{document.paymentReference}</dd></div> : null}
      {isCash ? <><div><dt>Cash received</dt><dd>{money.format(document.tenderedAmount || document.total)}</dd></div><div><dt>Change</dt><dd>{money.format(document.changeDue || 0)}</dd></div></> : null}
    </dl> : null}

    {template.showPoints && document.pointsEarned ? <section className="receipt-points"><Leaf size={13} /><span><strong>+{document.pointsEarned} points</strong>{document.pointsBalance !== undefined ? ` · Balance ${document.pointsBalance}` : ""}</span></section> : null}
    {document.saleNote ? <p className="receipt-sale-note"><strong>Order note</strong>{document.saleNote}</p> : null}

    <footer className="receipt-paper-footer">
      {template.thankYouText ? <strong>{template.thankYouText}</strong> : null}
      {template.returnPolicy ? <p>{template.returnPolicy}</p> : null}
      {template.website ? <span>{template.website}</span> : null}
      {template.footerText ? <small>{template.footerText}</small> : null}
    </footer>
  </article>;
}
