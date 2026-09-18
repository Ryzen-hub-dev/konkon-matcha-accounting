"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookCheck, CalendarRange, CheckCircle2, Landmark, Laptop, LockKeyhole, RotateCcw, ShieldCheck } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";

type Checklist = {
  journalCount: number; totalDebit: number; totalCredit: number; unbalancedCount: number;
  requiredBankAccountCount: number; reconciledBankAccountCount: number;
  missingBankAccounts: Array<{ code: string; name: string }>;
  openBankReconciliationCount: number; fixedAssetDueCount: number; blockers: string[]; ready: boolean;
};
type Period = {
  _id?: string; periodKey: string; status: "OPEN" | "CLOSED"; isCurrent: boolean; canClose: boolean;
  updatedAt?: string; closeNote?: string; closedAt?: string; closedByName?: string;
  reopenNote?: string; reopenedAt?: string; checklist: Checklist; liveChecklist: Checklist; integrityChanged?: boolean;
};
type PeriodData = { periods: Period[]; currentPeriodKey: string; currency: string; timeZone: string };

export function PeriodCloseView({ canClose, canReopen }: { canClose: boolean; canReopen: boolean }) {
  const { profile } = useBusiness();
  const [data, setData] = useState<PeriodData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  const [action, setAction] = useState<{ kind: "CLOSE" | "REOPEN"; period: Period } | null>(null);
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try { setData(await apiRequest<PeriodData>("/api/accounting-periods")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load accounting periods.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const periods = data?.periods || [];
  const visible = useMemo(() => periods.filter(period => filter === "ALL"
    || (filter === "CLOSED" && period.status === "CLOSED")
    || (filter === "READY" && period.status === "OPEN" && period.canClose && period.liveChecklist.ready)
    || (filter === "BLOCKED" && period.status === "OPEN" && period.canClose && !period.liveChecklist.ready)), [periods, filter]);
  const closedCount = periods.filter(period => period.status === "CLOSED").length;
  const readyCount = periods.filter(period => period.status === "OPEN" && period.canClose && period.liveChecklist.ready).length;
  const blockedCount = periods.filter(period => period.status === "OPEN" && period.canClose && !period.liveChecklist.ready).length;
  const money = new Intl.NumberFormat(profile.locale, { style: "currency", currency: data?.currency || profile.currency });

  return <div className="page page-enter period-close-page">
    <PageHeader eyebrow="ACCOUNTING CONTROL" title="Month-end close" description="Review journals and bank coverage, lock completed months, and prevent back-dated postings across every financial workflow." />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row period-close-stats"><article><LockKeyhole /><span>Closed months</span><strong>{closedCount}</strong></article><article><CheckCircle2 /><span>Ready to close</span><strong>{readyCount}</strong></article><article><AlertTriangle /><span>Need attention</span><strong>{blockedCount}</strong></article></section>
    <section className="panel period-close-policy"><ShieldCheck /><div><strong>A closed month is enforced by the server, not just hidden in the interface.</strong><p>Manual journals, POS, refunds, invoice payments, goods receipts, supplier payments and inventory disposals all check the period inside their MongoDB transaction. Only the Owner can reopen, in reverse closing order.</p></div></section>
    <section className="panel period-close-register">
      <header className="period-close-toolbar"><div><CalendarRange /><span><strong>Period register</strong><small>{data ? `${data.timeZone} · ${data.currency}` : "Preparing controls…"}</small></span></div><label className="field"><span>Show</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="ALL">All periods</option><option value="READY">Ready</option><option value="BLOCKED">Need attention</option><option value="CLOSED">Closed</option></select></label><button className="button button-secondary" disabled={loading} onClick={() => void load()}>Refresh</button></header>
      {loading ? <LoadingPanel label="Checking journals and bank reconciliations…" /> : visible.length ? <div className="period-close-list">{visible.map(period => {
        const checklist = period.status === "CLOSED" ? period.checklist : period.liveChecklist;
        const ready = period.status === "OPEN" && period.canClose && checklist.ready;
        return <article className={`period-close-card ${period.status === "CLOSED" ? "is-closed" : ready ? "is-ready" : ""}`} key={period.periodKey}>
          <header><div><span>{period.isCurrent ? "CURRENT PERIOD" : period.status === "CLOSED" ? "LOCKED WORKING PERIOD" : "ACCOUNTING PERIOD"}</span><h2>{formatPeriod(period.periodKey, profile.locale)}</h2><small>{period.periodKey}</small></div><StatusPill value={period.status} /></header>
          <div className="period-close-totals"><span><small>Posted journals</small><strong>{checklist.journalCount}</strong></span><span><small>Total debits</small><strong>{money.format(checklist.totalDebit)}</strong></span><span><small>Total credits</small><strong>{money.format(checklist.totalCredit)}</strong></span><span><small>Bank coverage</small><strong>{checklist.reconciledBankAccountCount}/{checklist.requiredBankAccountCount}</strong></span><span><small>Asset depreciation due</small><strong>{checklist.fixedAssetDueCount}</strong></span></div>
          {period.status === "CLOSED" ? <>{period.integrityChanged ? <div className="period-close-integrity"><AlertTriangle /><span><strong>Locked snapshot no longer matches the live ledger</strong><small>Investigate direct database or legacy writes before relying on this month.</small></span></div> : null}<div className="period-close-evidence"><BookCheck /><span><strong>Closed by {period.closedByName || "authorised staff"}</strong><small>{period.closedAt ? new Intl.DateTimeFormat(profile.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(period.closedAt)) : "Locked"} · {period.closeNote}</small></span></div></> : period.isCurrent ? <div className="period-close-current"><CalendarRange /><span>This calendar month is still active and cannot be closed yet.</span></div> : checklist.blockers.length ? <div className="period-close-blockers"><strong>Before closing</strong><ul>{checklist.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>{checklist.missingBankAccounts.length || checklist.openBankReconciliationCount ? <Link href="/bank-reconciliation"><Landmark size={14} />Open bank reconciliation</Link> : null}{checklist.fixedAssetDueCount ? <Link href="/fixed-assets"><Laptop size={14} />Open fixed assets</Link> : null}</div> : <div className="period-close-ready"><CheckCircle2 /><span><strong>Ready to close</strong><small>Journal totals agree, required bank accounts are reconciled, and asset depreciation is complete.</small></span></div>}
          <footer>{period.status === "CLOSED" ? canReopen ? <button className="button button-quiet" onClick={() => setAction({ kind: "REOPEN", period })}><RotateCcw size={14} />Reopen month</button> : <small>Owner authority is required to reopen.</small> : ready && canClose ? <button className="button button-primary" onClick={() => setAction({ kind: "CLOSE", period })}><LockKeyhole size={14} />Close & lock month</button> : !canClose ? <small>Accounting write permission is required to close.</small> : null}</footer>
        </article>;
      })}</div> : <EmptyState title="No periods match this filter" detail="Choose another period status to continue." />}
    </section>
    {action ? <PeriodAction action={action} onClose={() => setAction(null)} onComplete={async message => { setAction(null); show(message); await load(); }} /> : null}
  </div>;
}

function PeriodAction({ action, onClose, onComplete }: { action: { kind: "CLOSE" | "REOPEN"; period: Period }; onClose: () => void; onComplete: (message: string) => void | Promise<void> }) {
  const { profile } = useBusiness();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      await apiRequest("/api/accounting-periods", { method: "PATCH", body: JSON.stringify({ action: action.kind, periodKey: action.period.periodKey, note, expectedUpdatedAt: action.period.updatedAt }) });
      await onComplete(action.kind === "CLOSE" ? `${formatPeriod(action.period.periodKey, profile.locale)} closed and locked.` : `${formatPeriod(action.period.periodKey, profile.locale)} reopened with Owner authority.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update this accounting period."); }
    finally { setBusy(false); }
  }
  return <Modal open onClose={() => { if (!busy) onClose(); }} title={`${action.kind === "CLOSE" ? "Close" : "Reopen"} ${formatPeriod(action.period.periodKey, profile.locale)}`} kicker={action.kind === "CLOSE" ? "MONTH-END LOCK" : "OWNER OVERRIDE"}><form className="modal-form period-action-form" onSubmit={submit}>{error ? <div className="invoice-form-error" role="alert">{error}</div> : null}<div className={`period-action-warning ${action.kind === "REOPEN" ? "danger" : ""}`}><LockKeyhole /><p>{action.kind === "CLOSE" ? "After closing, every supported posting workflow will reject transactions dated inside this month." : "Reopening allows back-dated postings and can change later reports. Later closed months must be reopened first."}</p></div><label className="field"><span>{action.kind === "CLOSE" ? "Reviewer note" : "Reopening reason"}</span><textarea value={note} onChange={event => setNote(event.target.value)} minLength={3} maxLength={300} rows={3} required placeholder={action.kind === "CLOSE" ? "Checks completed and reviewer identity…" : "Why must this locked period change?"} /></label><footer><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || note.trim().length < 3}>{busy ? "Saving…" : action.kind === "CLOSE" ? "Confirm close" : "Confirm reopen"}</button></footer></form></Modal>;
}

function formatPeriod(periodKey: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${periodKey}-01T00:00:00.000Z`));
}
