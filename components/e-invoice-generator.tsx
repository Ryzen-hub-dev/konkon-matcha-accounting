"use client";
import { FormEvent, useRef, useState } from "react";
import { FileCode2, Download } from "lucide-react";
import { apiRequest, Modal } from "./ui";
import { COUNTRY_PROFILES } from "@/lib/international";
import { downloadReceiptFile } from "@/lib/receipt-export";

type Party = { name: string; registrationNo: string; address: string; countryCode: string; email: string; phone: string };
type History = { _id: string; format: string; filename: string; createdAt: string; sha256: string; status: string };
type Details = { canGenerate: boolean; sourceStatus: string; currency: string; total: number; tax: number; countryCode: string; seller: Party; buyer: Party; history: History[] };

export function EInvoiceGenerator({ sourceId, sourceType }: { sourceId: string; sourceType: "INVOICE" | "RECEIPT" }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Details | null>(null);
  const [format, setFormat] = useState("UBL_XML");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const endpoint = `/api/e-invoices?sourceType=${sourceType}&sourceId=${sourceId}`;
  async function load() { const result = await apiRequest<Details>(endpoint); setData(result); }
  async function show() {
    setOpen(true); setBusy(true); setError(""); setMessage("");
    try { await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load e-invoices."); } finally { setBusy(false); }
  }
  async function download(id: string, filename: string) {
    setError("");
    try {
      const response = await fetch(`${endpoint}&id=${id}`, { cache: "no-store" });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Could not download the file."); }
      downloadReceiptFile(await response.text(), response.headers.get("content-type") || "application/octet-stream", filename);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not download the file."); }
  }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const party = (prefix: string) => Object.fromEntries(["name", "registrationNo", "taxId", "address", "city", "postalCode", "stateCode", "email", "phone", "countryCode"].map(key => [key, String(form.get(`${prefix}.${key}`) || "")]));
    setBusy(true); setError(""); setMessage("");
    try {
      await apiRequest("/api/e-invoices", { method: "POST", body: JSON.stringify({ sourceId, sourceType, clientRequestId: requestId.current, format, seller: party("seller"), buyer: party("buyer"), taxCategory: form.get("taxCategory"), taxReason: form.get("taxReason"), confirmed: form.get("confirmed") === "on", ...(format === "MYINVOIS_JSON" ? { malaysia: Object.fromEntries(["msic", "activity", "classification", "taxType", "sellerSst", "buyerSst"].map(key => [key, String(form.get(`malaysia.${key}`) || "")])) } : {}) }) });
      requestId.current = crypto.randomUUID(); setMessage("Electronic document saved. Download it below. It has not been submitted or accepted by a tax authority."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not generate the e-invoice."); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="button button-secondary no-print" onClick={() => void show()}><FileCode2 size={16} />E-invoice files</button>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title="Prepare an electronic invoice" kicker="DOCUMENT DESK · GENERATE & KEEP">
      <div className="e-invoice-desk">
        <aside className="document-readiness"><strong>File generation ≠ tax authority acceptance</strong><p>General UBL 2.1 XML and accounting JSON work as interchange files. They are not certified national formats, Singapore PINT-SG / InvoiceNow submissions, or tax filings. Country connectors, signatures and authority validation are separate.</p>{data ? <p>Original document: {data.sourceStatus} · {data.countryCode} · {data.currency} {data.total}. These amounts and the supplier country cannot be changed here.</p> : null}</aside>
        {error ? <p className="card-error" role="alert">{error}</p> : null}{message ? <p className="document-success" role="status">{message}</p> : null}
        {!data && busy ? <p>Loading the source document…</p> : null}
        {data?.canGenerate ? <form onSubmit={generate} onChange={() => { requestId.current = crypto.randomUUID(); }}>
          <label className="field"><span>File format</span><select value={format} onChange={event => setFormat(event.target.value)}><option value="UBL_XML">General UBL 2.1 XML — not a national submission</option><option value="ACCOUNTING_JSON">Structured accounting JSON</option>{data.countryCode === "MY" && data.currency === "MYR" ? <option value="MYINVOIS_JSON">MyInvois 1.0 JSON preparation — domestic MYR only</option> : null}</select></label>
          {format === "MYINVOIS_JSON" ? <aside className="document-readiness"><p>This adapter prepares an unsigned v1.0 file for Malaysian business buyers using BRN, one classification and one tax type. It is not signed, submitted, TIN-verified or a replacement for MyInvois validation. Generation uses the current UTC issue time and retains the original transaction reference.</p><a href="https://sdk.myinvois.hasil.gov.my/documents/invoice-v1-0/" target="_blank" rel="noreferrer">Check current LHDN version rules ↗</a></aside> : null}
          {(["seller", "buyer"] as const).map(prefix => <fieldset className="e-invoice-party" key={prefix}><legend>{prefix === "seller" ? "Supplier legal details" : "Buyer legal details"}</legend><div className="country-tax-fields">
            <label className="field"><span>Legal name</span><input name={`${prefix}.name`} defaultValue={data[prefix].name} required maxLength={120} minLength={2} /></label>
            <label className="field"><span>Country / region</span><select name={`${prefix}.countryCode`} defaultValue={data[prefix].countryCode} required>{prefix === "seller" ? <option value={data.countryCode}>{COUNTRY_PROFILES.find(c => c.code === data.countryCode)?.name || "Missing original country"}</option> : <><option value="">Choose country</option>{COUNTRY_PROFILES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</>}</select></label>
            <label className="field"><span>Business registration number {format === "MYINVOIS_JSON" ? "(BRN)" : ""}</span><input name={`${prefix}.registrationNo`} defaultValue={data[prefix].registrationNo} required maxLength={80} /></label>
            <label className="field"><span>Tax registration / TIN</span><input name={`${prefix}.taxId`} required={format === "MYINVOIS_JSON" || (prefix === "seller" && data.tax > 0)} maxLength={80} /></label>
            <label className="field"><span>Street address</span><input name={`${prefix}.address`} defaultValue={data[prefix].address} required minLength={3} maxLength={300} /></label>
            <label className="field"><span>City</span><input name={`${prefix}.city`} required maxLength={80} /></label>
            <label className="field"><span>Postal code</span><input name={`${prefix}.postalCode`} maxLength={20} /></label>
            <label className="field"><span>{format === "MYINVOIS_JSON" ? "Malaysia state code (2 digits)" : "State / region code"}</span><input name={`${prefix}.stateCode`} required={format === "MYINVOIS_JSON"} maxLength={30} /></label>
            <label className="field"><span>Email</span><input name={`${prefix}.email`} type="email" defaultValue={data[prefix].email} /></label>
            <label className="field"><span>Contact number</span><input name={`${prefix}.phone`} defaultValue={data[prefix].phone} required={format === "MYINVOIS_JSON"} maxLength={40} /></label>
          </div></fieldset>)}
          <div className="country-tax-fields"><label className="field"><span>Tax treatment for every line</span><select name="taxCategory" defaultValue={data.tax > 0 ? "S" : ""} required><option value="">Confirm zero-tax treatment</option><option value="S">Standard rated (tax charged)</option><option value="Z">Zero rated</option><option value="E">Exempt</option><option value="O">Outside scope / not applicable</option></select></label><label className="field"><span>Exemption / outside-scope reason</span><input name="taxReason" maxLength={200} placeholder="Required for exempt / outside-scope" /></label></div>
          {format === "MYINVOIS_JSON" ? <fieldset className="e-invoice-party"><legend>Malaysia classification — verify with your accountant</legend><div className="country-tax-fields">{[["msic", "Supplier MSIC (5 digits)", "5"], ["activity", "Business activity", "160"], ["classification", "Line classification (3 digits)", "3"], ["sellerSst", "Supplier SST registration (NA if not applicable)", "80"], ["buyerSst", "Buyer SST registration (NA if not applicable)", "80"]].map(([key, label, max]) => <label className="field" key={key}><span>{label}</span><input name={`malaysia.${key}`} required maxLength={Number(max)} /></label>)}<label className="field"><span>Tax type</span><select name="malaysia.taxType" required><option value="">Choose tax type</option><option value="01">01 Sales tax</option><option value="02">02 Service tax</option><option value="06">06 Not applicable</option><option value="E">E Tax exemption</option></select></label></div></fieldset> : null}
          <label className="document-confirmation"><input type="checkbox" name="confirmed" required /><span>I checked the parties and tax treatment. I understand this creates an immutable preparation file, not a submitted or validated tax invoice.</span></label>
          <button className="button button-primary" disabled={busy}>{busy ? "Generating…" : "Generate and save file"}</button>
        </form> : data ? <p>Your role can download existing files. Ask an accountant or manager to generate one.</p> : null}
        {data ? <section className="e-invoice-history"><h3>Saved document snapshots</h3>{data.history.length ? data.history.map(item => <article key={item._id}><div><strong>{item.format.replaceAll("_", " ")}</strong><small>{new Date(item.createdAt).toLocaleString()} · Not submitted</small><details><summary>Integrity checksum</summary><code>{item.sha256}</code></details></div><button className="button button-secondary" onClick={() => void download(item._id, item.filename)}><Download size={16} />Download</button></article>) : <p>No electronic files yet. The original invoice / receipt remains unchanged.</p>}</section> : null}
      </div>
    </Modal>
  </>;
}
