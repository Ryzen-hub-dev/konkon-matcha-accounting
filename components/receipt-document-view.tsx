"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Printer, RotateCcw, ShoppingBasket } from "lucide-react";
import { ReceiptPaper, type ReceiptPaperDocument } from "@/components/receipt-paper";
import { apiRequest, EmptyState, LoadingPanel, Modal, money, Notice, shortDate, useNotice } from "@/components/ui";
import { DEFAULT_RECEIPT_TEMPLATE, type ReceiptTemplateInput } from "@/lib/receipt-templates";

type RefundableItem = ReceiptPaperDocument["items"][number] & { productId: string; refundedQuantity?: number };
type SaleReceipt = Omit<ReceiptPaperDocument, "items"> & {
  _id: string;
  items: RefundableItem[];
  templateName?: string;
  templateSnapshot?: ReceiptTemplateInput;
};
type RefundRecord = {
  _id: string;
  refundNo: string;
  reason: string;
  total: number;
  createdByName: string;
  createdAt: string;
  items: Array<{ productId: string; name: string; quantity: number }>;
};

export function ReceiptDocumentView({ id, canRefund = false, canSell = false }: { id: string; canRefund?: boolean; canSell?: boolean }) {
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [refunds, setRefunds] = useState<RefundRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const { notice, show } = useNotice();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sale, refundData] = await Promise.all([
        apiRequest<SaleReceipt>(`/api/sales?id=${encodeURIComponent(id)}`),
        apiRequest<RefundRecord[]>(`/api/refunds?saleId=${encodeURIComponent(id)}`),
      ]);
      setReceipt(sale);
      setRefunds(refundData);
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not load the receipt.", "error");
    } finally {
      setLoading(false);
    }
  }, [id, show]);

  useEffect(() => { void load(); }, [load]);

  const remainingItems = useMemo(() => (receipt?.items || []).map((item) => ({ ...item, remaining: Math.max(0, item.quantity - Number(item.refundedQuantity || 0)) })).filter((item) => item.remaining > 0), [receipt]);

  function beginRefund() {
    setRefundQuantities(Object.fromEntries(remainingItems.map((item) => [item.productId, 0])));
    setReason("");
    setRefundOpen(true);
  }

  function selectAllRemaining() {
    setRefundQuantities(Object.fromEntries(remainingItems.map((item) => [item.productId, item.remaining])));
  }

  async function submitRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const items = remainingItems.map((item) => ({ productId: item.productId, quantity: Number(refundQuantities[item.productId] || 0) })).filter((item) => item.quantity > 0);
    if (!items.length) return show("Choose at least one item to refund.", "error");
    setRefundBusy(true);
    try {
      await apiRequest("/api/refunds", { method: "POST", body: JSON.stringify({ saleId: id, reason, items }) });
      setRefundOpen(false);
      show("Refund posted. Stock, tax, ledger and member points were reversed.");
      await load();
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not post the refund.", "error");
    } finally {
      setRefundBusy(false);
    }
  }

  if (loading && !receipt) return <div className="page"><LoadingPanel label="Feeding the receipt roll…" /></div>;
  if (!receipt) return <div className="page"><EmptyState title="Receipt unavailable" detail="Return to receipt history and choose another sale." action={<Link className="button button-secondary" href="/receipts">Back to receipts</Link>} /></div>;
  const template = { ...DEFAULT_RECEIPT_TEMPLATE, ...(receipt.templateSnapshot || {}) };

  return <div className="page receipt-document-page page-enter">
    {notice ? <Notice {...notice} /> : null}
    <header className="receipt-document-toolbar"><div><Link className="button button-secondary" href="/receipts"><ArrowLeft size={16} />Receipts</Link><span><small>HISTORICAL PAPER</small><strong>{receipt.receiptNo}</strong></span></div><div>{canRefund && remainingItems.length ? <button className="button button-secondary refund-button" onClick={beginRefund}><RotateCcw size={16} />Refund items</button> : null}{canSell ? <Link className="button button-secondary" href="/pos"><ShoppingBasket size={16} />New sale</Link> : null}<button className="button button-primary" onClick={() => window.print()}><Printer size={16} />Print or save PDF</button></div></header>
    <div className="receipt-document-stage"><ReceiptPaper document={receipt} template={template} /></div>

    {refunds.length ? <section className="panel receipt-refund-ledger"><header><div><span className="eyebrow">REVERSALS</span><h2>Refund history</h2></div><strong>{money.format(refunds.reduce((sum, refund) => sum + refund.total, 0))}</strong></header>{refunds.map((refund) => <div className="receipt-refund-row" key={refund._id}><span><strong>{refund.refundNo}</strong><small>{shortDate.format(new Date(refund.createdAt))} · {refund.createdByName}</small></span><span><strong>{refund.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}</strong><small>{refund.reason}</small></span><b>−{money.format(refund.total)}</b></div>)}</section> : null}

    <Modal open={refundOpen} onClose={() => setRefundOpen(false)} title="Refund receipt items" kicker="CONTROLLED REVERSAL"><form className="modal-form refund-form" onSubmit={submitRefund}><div className="refund-scope"><span>Returnable items</span><button type="button" onClick={selectAllRemaining}>Select all remaining</button></div><div className="refund-item-list">{remainingItems.map((item) => <label key={item.productId}><span><strong>{item.name}</strong><small>{item.remaining} of {item.quantity} still returnable · {money.format(item.price)} each</small></span><input type="number" min="0" max={item.remaining} step="1" value={refundQuantities[item.productId] || ""} onChange={(event) => setRefundQuantities((current) => ({ ...current, [item.productId]: Math.min(item.remaining, Math.max(0, Number(event.target.value))) }))} placeholder="0" /></label>)}</div><label className="field"><span>Refund reason</span><textarea rows={3} minLength={3} maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Damaged item, incorrect product, customer return…" required /></label><div className="refund-warning"><RotateCcw size={18} /><p>This posts a reversing journal, returns stock and adjusts member points. It cannot be deleted.</p></div><footer><button type="button" className="button button-secondary" onClick={() => setRefundOpen(false)}>Cancel</button><button className="button button-primary" disabled={refundBusy}><RotateCcw size={16} />{refundBusy ? "Posting refund…" : "Post refund"}</button></footer></form></Modal>
  </div>;
}
