"use client";
import { FormEvent, useRef, useState } from "react";
import { FileCode2, Download, RefreshCw, Send } from "lucide-react";
import { apiRequest, Modal } from "./ui";
import { COUNTRY_PROFILES } from "@/lib/international";
import { downloadReceiptFile } from "@/lib/receipt-export";

type Party = {
  name: string;
  registrationNo: string;
  address: string;
  countryCode: string;
  email: string;
  phone: string;
};
type History = {
  _id: string;
  format: string;
  filename: string;
  createdAt: string;
  sha256: string;
  status: string;
  myInvoisSubmissionUid?: string;
  myInvoisDocumentStatus?: string;
  myInvoisSubmissionState?: string;
  myInvoisLastError?: string;
};
type Details = {
  canGenerate: boolean;
  canSubmitMyInvois: boolean;
  sourceStatus: string;
  currency: string;
  total: number;
  tax: number;
  countryCode: string;
  seller: Party;
  buyer: Party;
  history: History[];
};

export function EInvoiceGenerator({
  sourceId,
  sourceType,
}: {
  sourceId: string;
  sourceType: "INVOICE" | "RECEIPT" | "PURCHASE_BILL";
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Details | null>(null);
  const [format, setFormat] = useState("UBL_XML");
  const [myInvoisType, setMyInvoisType] = useState(
    sourceType === "PURCHASE_BILL" ? "11" : "01",
  );
  const [transactionMode, setTransactionMode] = useState("STANDARD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const endpoint = `/api/e-invoices?sourceType=${sourceType}&sourceId=${sourceId}`;
  async function load() {
    const result = await apiRequest<Details>(endpoint);
    setData(result);
  }
  async function show() {
    setOpen(true);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load e-invoices.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function download(id: string, filename: string) {
    setError("");
    try {
      const response = await fetch(`${endpoint}&id=${id}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "Could not download the file.");
      }
      downloadReceiptFile(
        await response.text(),
        response.headers.get("content-type") || "application/octet-stream",
        filename,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not download the file.",
      );
    }
  }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const party = (prefix: string) =>
      Object.fromEntries(
        [
          "name",
          "registrationNo",
          "taxId",
          "address",
          "city",
          "postalCode",
          "stateCode",
          "email",
          "phone",
          "countryCode",
        ].map((key) => [key, String(form.get(`${prefix}.${key}`) || "")]),
      );
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const consolidatedBuyer = {
        name: "General Public",
        countryCode: "MY",
        registrationNo: "NA",
        taxId: "EI00000000010",
        address: "NA",
        city: "NA",
        postalCode: "00000",
        stateCode: "17",
        email: "",
        phone: "NA",
      };
      await apiRequest("/api/e-invoices", {
        method: "POST",
        body: JSON.stringify({
          sourceId,
          sourceType,
          clientRequestId: requestId.current,
          format,
          seller: party("seller"),
          buyer:
            format === "MYINVOIS_JSON" && transactionMode === "CONSOLIDATED"
              ? consolidatedBuyer
              : party("buyer"),
          taxCategory: form.get("taxCategory"),
          taxReason: form.get("taxReason"),
          confirmed: form.get("confirmed") === "on",
          ...(format === "MYINVOIS_JSON"
            ? {
                malaysia: Object.fromEntries(
                  [
                    "msic",
                    "activity",
                    "classification",
                    "taxType",
                    "sellerSst",
                    "buyerSst",
                    "referenceDocumentNo",
                    "referenceDocumentUuid",
                  ].map((key) => [
                    key,
                    String(form.get(`malaysia.${key}`) || ""),
                  ]),
                ),
                documentType: myInvoisType,
                transactionMode,
              }
            : {}),
        }),
      });
      requestId.current = crypto.randomUUID();
      await load();
      setMessage(
        "Electronic document saved. Download it below. It has not been submitted or accepted by a tax authority.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not generate the e-invoice.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function authorityAction(
    item: History,
    action: "SUBMIT" | "REFRESH_STATUS" | "LINK_SUBMISSION",
  ) {
    if (busy) return;
    const submissionUid =
      action === "LINK_SUBMISSION"
        ? window
            .prompt(
              "Enter the submission UID shown in the MyInvois portal for this document.",
            )
            ?.trim()
        : undefined;
    if (action === "LINK_SUBMISSION" && !submissionUid) return;
    const prompt =
      action === "SUBMIT"
        ? "Submit this immutable document to the connected MyInvois environment? This is an external tax-authority action and cannot be undone here."
        : action === "LINK_SUBMISSION"
          ? "Verify this submission with MyInvois and link it to the local document?"
          : "Refresh this document's MyInvois validation status now?";
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiRequest("/api/e-invoices/myinvois", {
        method: "POST",
        body: JSON.stringify({
          id: item._id,
          action,
          confirmed: true,
          ...(submissionUid ? { submissionUid } : {}),
        }),
      });
      await load();
      setMessage(
        action === "SUBMIT"
          ? "MyInvois accepted the submission for authority validation. Refresh status after processing."
          : action === "LINK_SUBMISSION"
            ? "The authority submission was verified and linked."
            : "Authority status refreshed from MyInvois.",
      );
    } catch (reason) {
      try {
        await load();
      } catch {}
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not complete the MyInvois action.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="button button-secondary no-print"
        onClick={() => void show()}
      >
        <FileCode2 size={16} />
        E-invoice files
      </button>
      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="Prepare an electronic invoice"
        kicker="DOCUMENT DESK · GENERATE & KEEP"
      >
        <div className="e-invoice-desk">
          <aside className="document-readiness">
            <strong>File generation ≠ tax authority acceptance</strong>
            <p>
              General UBL 2.1 XML and accounting JSON work as interchange files.
              They are not certified national formats, Singapore PINT-SG /
              InvoiceNow submissions, or tax filings. Country connectors,
              signatures and authority validation are separate.
            </p>
            {data ? (
              <p>
                Original document: {data.sourceStatus} · {data.countryCode} ·{" "}
                {data.currency} {data.total}. These amounts and the supplier
                country cannot be changed here.
              </p>
            ) : null}
          </aside>
          {error ? (
            <p className="card-error" role="alert">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="document-success" role="status">
              {message}
            </p>
          ) : null}
          {!data && busy ? <p>Loading the source document…</p> : null}
          {data?.canGenerate ? (
            <form
              onSubmit={generate}
              onChange={() => {
                requestId.current = crypto.randomUUID();
              }}
            >
              <label className="field">
                <span>File format</span>
                <select
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                >
                  <option value="UBL_XML">
                    General UBL 2.1 XML — not a national submission
                  </option>
                  <option value="ACCOUNTING_JSON">
                    Structured accounting JSON
                  </option>
                  {data.countryCode === "MY" && data.currency === "MYR" ? (
                    <option value="MYINVOIS_JSON">
                      MyInvois 1.0 JSON preparation — domestic MYR only
                    </option>
                  ) : null}
                </select>
              </label>
              {format === "MYINVOIS_JSON" ? (
                <aside className="document-readiness">
                  <p>
                    This adapter prepares unsigned v1.0 standard, consolidated,
                    credit/debit/refund and self-billed document structures. It
                    is not signed, submitted, TIN-verified or a replacement for
                    MyInvois validation. Generation uses the current UTC issue
                    time and retains the original transaction reference.
                  </p>
                  <a
                    href="https://sdk.myinvois.hasil.gov.my/documents/invoice-v1-0/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Check current LHDN version rules ↗
                  </a>
                </aside>
              ) : null}
              {(["seller", "buyer"] as const).map((prefix) =>
                prefix === "buyer" &&
                format === "MYINVOIS_JSON" &&
                transactionMode === "CONSOLIDATED" ? null : (
                  <fieldset className="e-invoice-party" key={prefix}>
                    <legend>
                      {prefix === "seller"
                        ? sourceType === "PURCHASE_BILL"
                          ? "Supplier legal details · self-billed seller"
                          : "Supplier legal details"
                        : sourceType === "PURCHASE_BILL"
                          ? "Buyer legal details · your business"
                          : "Buyer legal details"}
                    </legend>
                    <div className="country-tax-fields">
                      <label className="field">
                        <span>Legal name</span>
                        <input
                          name={`${prefix}.name`}
                          defaultValue={data[prefix].name}
                          required
                          maxLength={120}
                          minLength={2}
                        />
                      </label>
                      <label className="field">
                        <span>Country / region</span>
                        <select
                          name={`${prefix}.countryCode`}
                          defaultValue={data[prefix].countryCode}
                          required
                        >
                          {prefix === "seller" ? (
                            <option value={data.countryCode}>
                              {COUNTRY_PROFILES.find(
                                (c) => c.code === data.countryCode,
                              )?.name || "Missing original country"}
                            </option>
                          ) : (
                            <>
                              <option value="">Choose country</option>
                              {COUNTRY_PROFILES.map((c) => (
                                <option key={c.code} value={c.code}>
                                  {c.name}
                                </option>
                              ))}
                            </>
                          )}
                        </select>
                      </label>
                      <label className="field">
                        <span>
                          Business registration number{" "}
                          {format === "MYINVOIS_JSON" ? "(BRN)" : ""}
                        </span>
                        <input
                          name={`${prefix}.registrationNo`}
                          defaultValue={data[prefix].registrationNo}
                          required
                          maxLength={80}
                        />
                      </label>
                      <label className="field">
                        <span>Tax registration / TIN</span>
                        <input
                          name={`${prefix}.taxId`}
                          required={
                            format === "MYINVOIS_JSON" ||
                            (prefix === "seller" && data.tax > 0)
                          }
                          maxLength={80}
                        />
                      </label>
                      <label className="field">
                        <span>Street address</span>
                        <input
                          name={`${prefix}.address`}
                          defaultValue={data[prefix].address}
                          required
                          minLength={3}
                          maxLength={300}
                        />
                      </label>
                      <label className="field">
                        <span>City</span>
                        <input
                          name={`${prefix}.city`}
                          required
                          maxLength={80}
                        />
                      </label>
                      <label className="field">
                        <span>Postal code</span>
                        <input name={`${prefix}.postalCode`} maxLength={20} />
                      </label>
                      <label className="field">
                        <span>
                          {format === "MYINVOIS_JSON"
                            ? "Malaysia state code (2 digits)"
                            : "State / region code"}
                        </span>
                        <input
                          name={`${prefix}.stateCode`}
                          required={format === "MYINVOIS_JSON"}
                          maxLength={30}
                        />
                      </label>
                      <label className="field">
                        <span>Email</span>
                        <input
                          name={`${prefix}.email`}
                          type="email"
                          defaultValue={data[prefix].email}
                        />
                      </label>
                      <label className="field">
                        <span>Contact number</span>
                        <input
                          name={`${prefix}.phone`}
                          defaultValue={data[prefix].phone}
                          required={format === "MYINVOIS_JSON"}
                          maxLength={40}
                        />
                      </label>
                    </div>
                  </fieldset>
                ),
              )}
              <div className="country-tax-fields">
                <label className="field">
                  <span>Tax treatment for every line</span>
                  <select
                    name="taxCategory"
                    defaultValue={data.tax > 0 ? "S" : ""}
                    required
                  >
                    <option value="">Confirm zero-tax treatment</option>
                    <option value="S">Standard rated (tax charged)</option>
                    <option value="Z">Zero rated</option>
                    <option value="E">Exempt</option>
                    <option value="O">Outside scope / not applicable</option>
                  </select>
                </label>
                <label className="field">
                  <span>Exemption / outside-scope reason</span>
                  <input
                    name="taxReason"
                    maxLength={200}
                    placeholder="Required for exempt / outside-scope"
                  />
                </label>
              </div>
              {format === "MYINVOIS_JSON" ? (
                <fieldset className="e-invoice-party">
                  <legend>
                    Malaysia classification — verify with your accountant
                  </legend>
                  <div className="country-tax-fields">
                    <label className="field">
                      <span>MyInvois document type</span>
                      <select
                        value={myInvoisType}
                        onChange={(event) => {
                          setMyInvoisType(event.target.value);
                          if (event.target.value !== "01")
                            setTransactionMode("STANDARD");
                        }}
                        required
                      >
                        {sourceType === "PURCHASE_BILL" ? (
                          <>
                            <option value="11">11 Self-billed invoice</option>
                            <option value="12">
                              12 Self-billed credit note
                            </option>
                            <option value="13">
                              13 Self-billed debit note
                            </option>
                            <option value="14">
                              14 Self-billed refund note
                            </option>
                          </>
                        ) : (
                          <>
                            <option value="01">01 Invoice</option>
                            <option value="02">02 Credit note</option>
                            <option value="03">03 Debit note</option>
                            <option value="04">04 Refund note</option>
                          </>
                        )}
                      </select>
                    </label>
                    {sourceType === "RECEIPT" && myInvoisType === "01" ? (
                      <label className="field">
                        <span>Transaction mode</span>
                        <select
                          value={transactionMode}
                          onChange={(event) =>
                            setTransactionMode(event.target.value)
                          }
                        >
                          <option value="STANDARD">Standard buyer</option>
                          <option value="CONSOLIDATED">
                            Consolidated · General Public
                          </option>
                        </select>
                      </label>
                    ) : null}
                    {["02", "03", "04", "12", "13", "14"].includes(
                      myInvoisType,
                    ) ? (
                      <>
                        <label className="field">
                          <span>Original document number</span>
                          <input
                            name="malaysia.referenceDocumentNo"
                            maxLength={50}
                            required
                          />
                        </label>
                        <label className="field">
                          <span>Original MyInvois UUID</span>
                          <input
                            name="malaysia.referenceDocumentUuid"
                            maxLength={100}
                            required
                          />
                        </label>
                      </>
                    ) : null}
                    {[
                      ["msic", "Supplier MSIC (5 digits)", "5"],
                      ["activity", "Business activity", "160"],
                      ["classification", "Line classification (3 digits)", "3"],
                      [
                        "sellerSst",
                        "Supplier SST registration (NA if not applicable)",
                        "80",
                      ],
                      [
                        "buyerSst",
                        "Buyer SST registration (NA if not applicable)",
                        "80",
                      ],
                    ].map(([key, label, max]) => (
                      <label className="field" key={key}>
                        <span>{label}</span>
                        <input
                          key={`${key}-${transactionMode}`}
                          name={`malaysia.${key}`}
                          required
                          maxLength={Number(max)}
                          defaultValue={
                            key === "classification" &&
                            transactionMode === "CONSOLIDATED"
                              ? "004"
                              : undefined
                          }
                        />
                      </label>
                    ))}
                    <label className="field">
                      <span>Tax type</span>
                      <select name="malaysia.taxType" required>
                        <option value="">Choose tax type</option>
                        <option value="01">01 Sales tax</option>
                        <option value="02">02 Service tax</option>
                        <option value="03">03 Tourism tax</option>
                        <option value="04">04 High-value goods tax</option>
                        <option value="05">05 Low-value goods sales tax</option>
                        <option value="06">06 Not applicable</option>
                        <option value="E">E Tax exemption</option>
                      </select>
                    </label>
                  </div>
                </fieldset>
              ) : null}
              <label className="document-confirmation">
                <input type="checkbox" name="confirmed" required />
                <span>
                  I checked the parties and tax treatment. I understand this
                  creates an immutable preparation file, not a submitted or
                  validated tax invoice.
                </span>
              </label>
              <button className="button button-primary" disabled={busy}>
                {busy ? "Generating…" : "Generate and save file"}
              </button>
            </form>
          ) : data ? (
            <p>
              Your role can download existing files. Ask an accountant or
              manager to generate one.
            </p>
          ) : null}
          {data ? (
            <section className="e-invoice-history">
              <h3>Saved document snapshots</h3>
              {data.history.length ? (
                data.history.map((item) => (
                  <article key={item._id}>
                    <div>
                      <strong>{item.format.replaceAll("_", " ")}</strong>
                      <small>
                        {new Date(item.createdAt).toLocaleString()} ·{" "}
                        {item.myInvoisDocumentStatus ||
                          item.status.replaceAll("_", " ")}
                      </small>
                      {item.myInvoisSubmissionUid ? (
                        <small>
                          Authority submission {item.myInvoisSubmissionUid}
                        </small>
                      ) : null}
                      {item.myInvoisLastError ? (
                        <small>{item.myInvoisLastError}</small>
                      ) : null}
                      <details>
                        <summary>Integrity checksum</summary>
                        <code>{item.sha256}</code>
                      </details>
                    </div>
                    <div className="row-actions">
                      <button
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => void download(item._id, item.filename)}
                      >
                        <Download size={16} />
                        Download
                      </button>
                      {data.canSubmitMyInvois &&
                      item.format === "MYINVOIS_JSON" &&
                      !item.myInvoisSubmissionUid &&
                      !["IN_PROGRESS", "REVIEW_REQUIRED"].includes(
                        item.myInvoisSubmissionState || "",
                      ) ? (
                        <button
                          className="button button-primary"
                          disabled={busy}
                          onClick={() => void authorityAction(item, "SUBMIT")}
                        >
                          <Send size={15} />
                          Submit MyInvois
                        </button>
                      ) : null}
                      {data.canSubmitMyInvois &&
                      item.format === "MYINVOIS_JSON" &&
                      !item.myInvoisSubmissionUid &&
                      ["IN_PROGRESS", "REVIEW_REQUIRED"].includes(
                        item.myInvoisSubmissionState || "",
                      ) ? (
                        <button
                          className="button button-secondary"
                          disabled={busy}
                          onClick={() =>
                            void authorityAction(item, "LINK_SUBMISSION")
                          }
                        >
                          <RefreshCw size={15} />
                          Link authority result
                        </button>
                      ) : null}
                      {data.canSubmitMyInvois && item.myInvoisSubmissionUid ? (
                        <button
                          className="button button-secondary"
                          disabled={busy}
                          onClick={() =>
                            void authorityAction(item, "REFRESH_STATUS")
                          }
                        >
                          <RefreshCw size={15} />
                          Refresh status
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))
              ) : (
                <p>
                  No electronic files yet. The original invoice / receipt
                  remains unchanged.
                </p>
              )}
            </section>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
