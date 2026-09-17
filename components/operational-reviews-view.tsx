"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, FileSearch2, Search, ShieldAlert, UserCheck } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import type { OperationalReviewRecord, ReviewCategory } from "@/lib/operational-reviews";

type ReviewData = {
  reviews: OperationalReviewRecord[];
  counts: { open: number; inReview: number; high: number; security: number };
};

type ReviewAction = "ACKNOWLEDGE" | "RESOLVE" | "REOPEN";

const categories: Array<{ value: "ALL" | ReviewCategory; label: string }> = [
  { value: "ALL", label: "All categories" },
  { value: "DISCOUNT", label: "Discounts" },
  { value: "REFUND", label: "Refunds" },
  { value: "INVENTORY", label: "Inventory" },
  { value: "REGISTER", label: "Registers" },
  { value: "SECURITY", label: "Security" },
];

function actionCopy(action: ReviewAction) {
  if (action === "ACKNOWLEDGE") return { title: "Acknowledge exception", button: "Assign to me", help: "This records that you are investigating the item. An optional note can record the first check." };
  if (action === "REOPEN") return { title: "Reopen exception", button: "Reopen item", help: "Explain why the previous resolution no longer closes the issue." };
  return { title: "Resolve exception", button: "Record resolution", help: "Record what was checked and why no further action is required." };
}

export function OperationalReviewsView({ canManage }: { canManage: boolean }) {
  const { dateTime, profile } = useBusiness();
  const [data, setData] = useState<ReviewData>({ reviews: [], counts: { open: 0, inReview: 0, high: 0, security: 0 } });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("ACTIVE");
  const [category, setCategory] = useState("ALL");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [selected, setSelected] = useState<OperationalReviewRecord | null>(null);
  const [action, setAction] = useState<ReviewAction>("ACKNOWLEDGE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const { notice, show } = useNotice();

  async function load(nextQuery = appliedQuery) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status, category });
      if (nextQuery) params.set("q", nextQuery);
      setData(await apiRequest<ReviewData>(`/api/operational-reviews?${params}`));
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load exception reviews.", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [status, category]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  });

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = query.trim();
    setAppliedQuery(next);
    void load(next);
  }

  function openAction(item: OperationalReviewRecord, nextAction: ReviewAction) {
    setSelected(item);
    setAction(nextAction);
    setNote("");
  }

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    try {
      await apiRequest("/api/operational-reviews", { method: "PATCH", body: JSON.stringify({ action, id: selected._id, version: selected.version, note }) });
      show(action === "ACKNOWLEDGE" ? "Exception assigned for investigation." : action === "REOPEN" ? "Exception reopened." : "Resolution recorded.");
      setSelected(null);
      setNote("");
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not update the exception.", "error");
    } finally {
      setBusy(false);
    }
  }

  function amount(item: OperationalReviewRecord) {
    if (item.amount === undefined) return null;
    try { return new Intl.NumberFormat(profile.locale, { style: "currency", currency: item.currency || profile.currency }).format(item.amount); }
    catch { return `${item.currency || profile.currency} ${item.amount.toFixed(2)}`; }
  }

  const copy = actionCopy(action);
  return <div className="page page-enter review-page">
    <PageHeader eyebrow="CONTROL DESK" title="Exception reviews" description="Investigate unusual discounts, refunds, shrinkage, register variances and repeated sign-in failures from one accountable queue." />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row review-stats">
      <article className={data.counts.open ? "warn" : ""}><AlertTriangle /><span>Unassigned</span><strong>{data.counts.open}</strong></article>
      <article><UserCheck /><span>In review</span><strong>{data.counts.inReview}</strong></article>
      <article className={data.counts.high ? "warn" : ""}><ShieldAlert /><span>High priority</span><strong>{data.counts.high}</strong></article>
      <article><FileSearch2 /><span>Security items</span><strong>{data.counts.security}</strong></article>
    </section>
    <section className="review-policy panel">
      <ShieldAlert />
      <div><strong>Transparent rules, human decisions</strong><p>The queue flags manual discounts of at least 10%, cumulative refunds of at least 50%, material negative stock changes, cash variances and five failed sign-ins. It never reverses a transaction or accuses a staff member automatically.</p></div>
    </section>
    <section className="panel resource-panel review-panel">
      <div className="review-toolbar">
        <form className="search-box" onSubmit={search}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search review, source or staff" /><button type="submit">Search</button></form>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ACTIVE">Active</option><option value="OPEN">Open</option><option value="IN_REVIEW">In review</option><option value="RESOLVED">Resolved</option><option value="ALL">All</option></select></label>
        <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </div>
      {loading ? <LoadingPanel label="Reviewing operational evidence…" /> : data.reviews.length ? <div className="review-list">{data.reviews.map((item) => <article key={item._id} className={`review-card severity-${item.severity.toLowerCase()} status-${item.status.toLowerCase()}`}>
        <header><div><span>{item.category} · {item.reviewNo}</span><h2>{item.title}</h2></div><div><StatusPill value={item.severity} /><StatusPill value={item.status} /></div></header>
        <p>{item.summary}</p>
        <dl>
          <div><dt>Source</dt><dd>{item.sourceNo}</dd></div>
          <div><dt>Occurred</dt><dd>{dateTime.format(new Date(item.occurredAt))}</dd></div>
          <div><dt>Operator</dt><dd>{item.actorName} · {item.actorRole}</dd></div>
          {amount(item) ? <div><dt>Amount</dt><dd>{amount(item)}</dd></div> : null}
          {item.unitCount !== undefined ? <div><dt>Units affected</dt><dd>{item.unitCount}</dd></div> : null}
          {item.assignedToName ? <div><dt>Reviewer</dt><dd>{item.assignedToName}</dd></div> : null}
        </dl>
        {item.resolutionNote ? <aside><CheckCircle2 /><span><strong>Resolution</strong><small>{item.resolutionNote} · {item.resolvedByName}</small></span></aside> : null}
        <footer>
          {item.sourceHref ? <Link href={item.sourceHref} className="button button-secondary">Open source <ArrowUpRight size={14} /></Link> : <span />}
          {canManage && item.status === "OPEN" ? <button className="button button-secondary" onClick={() => openAction(item, "ACKNOWLEDGE")}><UserCheck size={14} />Assign to me</button> : null}
          {canManage && item.status !== "RESOLVED" && item.sourceType !== "registerShift" ? <button className="button button-primary" onClick={() => openAction(item, "RESOLVE")}><CheckCircle2 size={14} />Resolve</button> : null}
          {canManage && item.status === "RESOLVED" ? <button className="button button-secondary" onClick={() => openAction(item, "REOPEN")}><Clock3 size={14} />Reopen</button> : null}
        </footer>
      </article>)}</div> : <EmptyState title="No exceptions in this view" detail="New qualifying events appear automatically. Change the filters to inspect resolved history." />}
    </section>
    <Modal open={Boolean(selected)} onClose={() => { if (!busy) setSelected(null); }} title={copy.title} kicker={selected?.reviewNo || "REVIEW"}>
      <form className="modal-form" onSubmit={submitAction}><p className="form-hint">{copy.help}</p><label className="field"><span>Review note {action === "ACKNOWLEDGE" ? "· optional" : "· required"}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} minLength={action === "ACKNOWLEDGE" ? undefined : 3} maxLength={300} required={action !== "ACKNOWLEDGE"} autoFocus placeholder="What did you check, find or decide?" /></label><footer><button type="button" className="button button-secondary" disabled={busy} onClick={() => setSelected(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : copy.button}</button></footer></form>
    </Modal>
  </div>;
}
