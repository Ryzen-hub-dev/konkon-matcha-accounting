"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileArchive, FilePlus2, Search, Send, ShieldCheck, WalletCards, XCircle } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatCard, StatusPill, useNotice } from "@/components/ui";
import { EXPENSE_CATEGORIES } from "@/lib/expenses";
import { dateKeyInTimeZone } from "@/lib/dates";

type Account = { _id: string; code: string; name: string };
type Claim = { _id: string; claimNo: string; claimantId: string; claimantName: string; expenseDate: string; merchant: string; category: string; description: string; amount: number; taxAmount: number; expenseAmount: number; currency: string; expenseAccountCode: string; expenseAccountName: string; attachmentCount: number; status: string; reviewNote?: string; reviewedByName?: string; paymentNo?: string; paymentReference?: string; createdAt: string };
type Attachment = { _id: string; claimId: string; originalName: string; mimeType: string; originalSize: number; storedSize: number; encoding: string; createdAt: string };
type ExpenseData = { claims: Claim[]; attachments: Attachment[]; expenseAccounts: Account[]; paymentAccounts: Account[]; storageConfigured: boolean; permissions: { approve: boolean; pay: boolean; ownerSelfReview: boolean } };
const EMPTY_EXPENSE_DATA: ExpenseData = { claims: [], attachments: [], expenseAccounts: [], paymentAccounts: [], storageConfigured: false, permissions: { approve: false, pay: false, ownerSelfReview: false } };

export function ExpensesView({ userId }: { userId: string }) {
  const { profile, money, shortDate } = useBusiness();
  const [data, setData] = useState<ExpenseData>(EMPTY_EXPENSE_DATA);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Claim | null>(null);
  const [query, setQuery] = useState("");
  const actionPending = useRef(false);
  const { notice, show } = useNotice();
  async function load() {
    setLoading(true);
    try { setData(await apiRequest<ExpenseData>("/api/expense-claims")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load expense claims.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.claims || []).filter(claim => !needle || [claim.claimNo, claim.claimantName, claim.merchant, claim.category, claim.description, claim.status].some(value => value.toLowerCase().includes(needle)));
  }, [data?.claims, query]);
  const attachments = (claimId: string) => (data?.attachments || []).filter(item => item.claimId === claimId);
  const today = dateKeyInTimeZone(new Date(), profile.timeZone);

  async function upload(claimId: string, file: File) {
    const body = new FormData(); body.set("claimId", claimId); body.set("file", file);
    return apiRequest<Attachment>("/api/expense-attachments", { method: "POST", body });
  }
  async function createClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionPending.current) return;
    const form = new FormData(event.currentTarget), file = form.get("file");
    if (!(file instanceof File) || !file.size) { show("Choose a receipt or supporting document.", "error"); return; }
    if (file.size > 4 * 1024 * 1024) { show("Evidence files must be 4 MB or smaller on this deployment.", "error"); return; }
    actionPending.current = true; setBusy(true);
    try {
      const claim = await apiRequest<Claim>("/api/expense-claims", { method: "POST", body: JSON.stringify({ clientRequestId: crypto.randomUUID(), expenseDate: form.get("expenseDate"), merchant: form.get("merchant"), category: form.get("category"), description: form.get("description"), amount: form.get("amount"), taxAmount: form.get("taxAmount"), expenseAccountCode: form.get("expenseAccountCode") }) });
      await upload(claim._id, file);
      await apiRequest("/api/expense-claims", { method: "PATCH", body: JSON.stringify({ id: claim._id, action: "SUBMIT" }) });
      setCreating(false); show("Expense claim submitted with protected evidence."); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not submit the expense claim. Any created draft remains available for recovery.", "error"); await load(); }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function addEvidenceAndSubmit(claim: Claim, file?: File) {
    if (!file || actionPending.current) return;
    if (file.size > 4 * 1024 * 1024) { show("Evidence files must be 4 MB or smaller on this deployment.", "error"); return; }
    actionPending.current = true; setBusy(true);
    try { await upload(claim._id, file); await apiRequest("/api/expense-claims", { method: "PATCH", body: JSON.stringify({ id: claim._id, action: "SUBMIT" }) }); show("Evidence attached and claim submitted."); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not submit this draft.", "error"); await load(); }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function review(claim: Claim, action: "APPROVE" | "REJECT") {
    if (actionPending.current) return;
    const note = action === "REJECT" ? window.prompt("Reason for rejection (required)", "") : window.prompt("Approval note (optional)", "") || "";
    if (action === "REJECT" && (!note || note.trim().length < 3)) return;
    actionPending.current = true; setBusy(true);
    try { await apiRequest("/api/expense-claims", { method: "PATCH", body: JSON.stringify({ id: claim._id, action, note }) }); show(action === "APPROVE" ? "Claim approved for payment." : "Claim rejected with a recorded reason."); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not review this claim.", "error"); }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!paying || actionPending.current) return;
    actionPending.current = true; setBusy(true); const form = new FormData(event.currentTarget);
    try { await apiRequest("/api/expense-claims", { method: "PATCH", body: JSON.stringify({ id: paying._id, action: "PAY", clientRequestId: crypto.randomUUID(), paymentDate: form.get("paymentDate"), paymentAccountCode: form.get("paymentAccountCode"), reference: form.get("reference"), note: form.get("note") }) }); setPaying(null); show("Expense paid and posted to the ledger."); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not post this payment.", "error"); }
    finally { actionPending.current = false; setBusy(false); }
  }

  const waiting = data?.claims.filter(claim => claim.status === "SUBMITTED").length || 0;
  const approved = data?.claims.filter(claim => claim.status === "APPROVED").reduce((sum, claim) => sum + claim.amount, 0) || 0;
  const myDrafts = data?.claims.filter(claim => claim.status === "DRAFT" && claim.claimantId === userId).length || 0;
  return <div className="page page-enter expenses-page">
    <PageHeader eyebrow="STAFF SPEND CONTROL" title="Expense claims" description="Submit receipts, preserve original evidence, separate approval from the claimant, and post payment only after approval." action={<AddButton onClick={() => setCreating(true)}>New claim</AddButton>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="stat-grid expense-stat-grid"><StatCard label="Waiting for review" value={String(waiting)} detail="Submitted claims" icon={<ShieldCheck />} /><StatCard label="Approved to pay" value={money.format(approved)} detail="Not yet posted" tone="sand" icon={<WalletCards />} /><StatCard label="My drafts" value={String(myDrafts)} detail="Recoverable, not submitted" tone="ink" icon={<FileArchive />} /></section>
    {!data?.storageConfigured ? <section className="access-callout expense-storage-warning"><FileArchive /><div><strong>Evidence uploads are waiting for Owner setup</strong><p>Connect a private GitHub evidence repository in Workspace settings. Claims stay local as drafts until an attachment is safely stored.</p></div><span>OWNER ACTION</span></section> : null}
    <section className="panel resource-panel"><header className="panel-header"><div><span className="eyebrow">CLAIM REGISTER</span><h2>Review and payment trail</h2></div><label className="table-search"><Search size={15} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search claim, person, merchant or status" /></label></header>
      {loading ? <LoadingPanel label="Reading protected claims…" /> : visible.length ? <div className="expense-list">{visible.map(claim => <article className="expense-card" key={claim._id}><header><div><span>{claim.claimNo}</span><h3>{claim.merchant}</h3><small>{claim.claimantName} · {shortDate.format(new Date(`${claim.expenseDate}T00:00:00Z`))} · {claim.category.replaceAll("_", " ")}</small></div><div><strong>{money.format(claim.amount)}</strong><StatusPill value={claim.status} /></div></header><p>{claim.description}</p><div className="expense-account-line"><span>{claim.expenseAccountCode} · {claim.expenseAccountName}</span><span>Tax {money.format(claim.taxAmount)}</span></div><div className="expense-evidence">{attachments(claim._id).map(file => <a className="button button-quiet" key={file._id} href={`/api/expense-attachments/${file._id}`}><FileArchive size={14} />{file.originalName}<small>{Math.ceil(file.originalSize / 1024)} KB · lossless</small></a>)}{claim.status === "DRAFT" && claim.claimantId === userId ? <label className="button button-secondary file-action"><FilePlus2 size={14} />Attach & submit<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,text/plain" disabled={busy || !data.storageConfigured} onChange={event => { const file = event.target.files?.[0]; if (file) void addEvidenceAndSubmit(claim, file); }} /></label> : null}</div>{claim.reviewNote ? <small className="review-note">Review: {claim.reviewNote}{claim.reviewedByName ? ` · ${claim.reviewedByName}` : ""}</small> : null}<footer>{claim.status === "SUBMITTED" && data.permissions.approve && (claim.claimantId !== userId || data.permissions.ownerSelfReview) ? <><button className="button button-primary" disabled={busy} onClick={() => void review(claim, "APPROVE")}><CheckCircle2 size={15} />Approve</button><button className="button button-secondary danger" disabled={busy} onClick={() => void review(claim, "REJECT")}><XCircle size={15} />Reject</button></> : null}{claim.status === "APPROVED" && data.permissions.pay ? <button className="button button-primary" disabled={busy} onClick={() => setPaying(claim)}><WalletCards size={15} />Pay & post</button> : null}{claim.status === "PAID" ? <span className="form-hint">Payment {claim.paymentNo} · {claim.paymentReference}</span> : null}</footer></article>)}</div> : <EmptyState title="No expense claims" detail="Create the first staff claim and attach its receipt or supporting document." />}
    </section>
    <Modal open={creating} onClose={() => setCreating(false)} title="New expense claim" kicker="RECEIPT REQUIRED"><form className="modal-form wide-form" onSubmit={createClaim}><div className="form-grid three"><label className="field"><span>Expense date</span><input type="date" name="expenseDate" max={today} defaultValue={today} required /></label><label className="field"><span>Merchant</span><input name="merchant" minLength={2} maxLength={120} required autoFocus /></label><label className="field"><span>Category</span><select name="category" defaultValue="SUPPLIES">{EXPENSE_CATEGORIES.map(category => <option value={category} key={category}>{category.replaceAll("_", " ")}</option>)}</select></label></div><label className="field"><span>Business purpose</span><textarea name="description" rows={3} minLength={3} maxLength={500} required /></label><div className="form-grid three"><label className="field"><span>Total · {profile.currency}</span><input name="amount" type="number" min="0.01" step="0.01" required /></label><label className="field"><span>Tax included · {profile.currency}</span><input name="taxAmount" type="number" min="0" step="0.01" defaultValue="0" required /></label><label className="field"><span>Expense account</span><select name="expenseAccountCode" required>{data?.expenseAccounts.map(account => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label></div><label className="field"><span>Receipt / evidence · lossless protected upload</span><input name="file" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,text/plain" required disabled={!data?.storageConfigured} /></label><p className="form-hint">Maximum 4 MB for Vercel Hobby compatibility. The exact original bytes are recoverable after compression, encryption and integrity verification.</p><footer><button type="button" className="button button-secondary" onClick={() => setCreating(false)}>Cancel</button><button className="button button-primary" disabled={busy || !data?.storageConfigured || !data.expenseAccounts.length}><Send size={15} />{busy ? "Protecting evidence…" : "Submit claim"}</button></footer></form></Modal>
    <Modal open={Boolean(paying)} onClose={() => setPaying(null)} title={paying ? `Pay ${paying.claimNo}` : "Pay expense"} kicker="APPROVED CLAIM · LEDGER POSTING">{paying ? <form className="modal-form" onSubmit={pay}><div className="payment-summary"><strong>{money.format(paying.amount)}</strong><span>{paying.claimantName} · {paying.merchant}</span></div><div className="form-grid two"><label className="field"><span>Payment date</span><input type="date" name="paymentDate" min={paying.expenseDate} max={today} defaultValue={today} required /></label><label className="field"><span>Cash / bank account</span><select name="paymentAccountCode" required>{data?.paymentAccounts.map(account => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label></div><label className="field"><span>Payment reference</span><input name="reference" minLength={2} maxLength={100} required /></label><label className="field"><span>Payment note · optional</span><textarea name="note" maxLength={300} rows={2} /></label><footer><button type="button" className="button button-secondary" onClick={() => setPaying(null)}>Cancel</button><button className="button button-primary" disabled={busy || !data?.paymentAccounts.length}><WalletCards size={15} />{busy ? "Posting…" : "Pay & post journal"}</button></footer></form> : null}</Modal>
  </div>;
}
