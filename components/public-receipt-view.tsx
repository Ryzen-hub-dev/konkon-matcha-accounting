"use client";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "./ui";
import { ReceiptPaper, type ReceiptPaperDocument } from "./receipt-paper";
import { receiptCsv, downloadReceiptFile } from "@/lib/receipt-export";
import type { ReceiptTemplateInput } from "@/lib/receipt-templates";
import { printReceipt } from "@/lib/print-receipt";

export function PublicReceiptView() {
  const token = useRef<string | null>(null);
  const [receipt, setReceipt] = useState<(ReceiptPaperDocument & { eInvoice: object; templateSnapshot?: ReceiptTemplateInput }) | null>(null);
  const [error, setError] = useState("");
  const [printError, setPrintError] = useState("");
  useEffect(() => {
    if (token.current === null) {
      token.current = new URLSearchParams(location.hash.slice(1)).get("receipt") || "";
      history.replaceState(history.state, "", location.pathname);
    }
    void apiRequest<ReceiptPaperDocument & { eInvoice: object }>("/api/public-receipts", { method: "POST", body: JSON.stringify({ token: token.current }) }).then(setReceipt).catch(reason => setError(reason.message));
  }, []);
  return <main className="public-receipt-page"><header className="no-print"><span className="eyebrow">KŌN-KŌN · DIGITAL RECEIPT</span><h1>Your receipt</h1><p>Keep a copy for your records. For a return, show this receipt to the store.</p></header>
    {error ? <p role="alert">{error} Reopen the original receipt QR to try again.</p> : !receipt ? <p role="status">Opening your receipt…</p> : <>
      <nav className="document-toolbar no-print"><button className="button button-primary" onClick={() => { setPrintError(""); void printReceipt().catch(error => setPrintError(error.message)); }}>Print / save PDF</button><button className="button button-secondary" onClick={() => downloadReceiptFile(receiptCsv(receipt), "text/csv;charset=utf-8", `${receipt.receiptNo}.csv`)}>Export CSV</button><button className="button button-secondary" onClick={() => downloadReceiptFile(JSON.stringify(receipt, null, 2), "application/json", `${receipt.receiptNo}.json`)}>Export accounting JSON</button></nav>
      {printError ? <p className="no-print" role="alert">{printError}</p> : null}
      <div className="receipt-document-stage"><ReceiptPaper document={receipt} template={receipt.templateSnapshot} /></div><p className="no-print">This is a sales receipt. An electronic tax invoice has not been submitted. Your country’s e-invoice connection can be added later.</p>
    </>}
  </main>;
}
