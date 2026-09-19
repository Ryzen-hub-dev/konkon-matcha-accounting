"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Save, Target, TrendingDown, TrendingUp } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { apiRequest, EmptyState, LoadingPanel, Notice, PageHeader, StatCard, StatusPill, useNotice } from "@/components/ui";
import { dateKeyInTimeZone } from "@/lib/dates";
import { currencyFractionDigits } from "@/lib/international";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type BudgetType = "REVENUE" | "EXPENSE";
type BudgetPlan = { _id: string; year: number; revision: number; name: string; notes?: string; status: "DRAFT" | "APPROVED" | "SUPERSEDED"; version: number; updatedAt: string; approvedAt?: string; approvedByName?: string; approvalNote?: string };
type Variance = { budget: number; actual: number; difference: number; performance: number; favourable: boolean };
type BudgetRow = { code: string; name: string; type: BudgetType; active: boolean; monthlyBudget: number[]; monthlyActual: number[]; ytd: Variance; year: Variance };
type BudgetData = {
  year: number; today: string; ytdMonths: number; currency: string;
  permissions: { write: boolean; approve: boolean };
  plans: BudgetPlan[]; selected: BudgetPlan | null; rows: BudgetRow[];
  summary: { revenueBudget: number; revenueActual: number; expenseBudget: number; expenseActual: number; profitBudget: number; profitActual: number; profitVariance: number };
};

export function BudgetsView() {
  const { profile } = useBusiness();
  const currentYear = Number(dateKeyInTimeZone(new Date(), profile.timeZone).slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [selectedId, setSelectedId] = useState("");
  const [data, setData] = useState<BudgetData | null>(null);
  const [section, setSection] = useState<BudgetType>("REVENUE");
  const [monthly, setMonthly] = useState<Record<string, number[]>>({});
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const loadSequence = useRef(0);
  const { notice, show } = useNotice();
  const money = useMemo(() => new Intl.NumberFormat(profile.locale, { style: "currency", currency: data?.currency || profile.currency, maximumFractionDigits: currencyFractionDigits(data?.currency || profile.currency) }), [data?.currency, profile.currency, profile.locale]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const result = await apiRequest<BudgetData>(`/api/budgets?year=${year}${selectedId ? `&id=${encodeURIComponent(selectedId)}` : ""}`);
      if (sequence === loadSequence.current) setData(result);
    } catch (reason) { if (sequence === loadSequence.current) { setData(null); show(reason instanceof Error ? reason.message : "Could not load the budget workspace.", "error"); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [selectedId, show, year]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data) return;
    setName(data.selected?.name || `${data.year} operating budget`);
    setNotes(data.selected?.notes || "");
    setMonthly(Object.fromEntries(data.rows.map(row => [row.code, row.monthlyBudget.slice(0, 12)])));
    setDirty(false);
  }, [data]);

  const rows = data?.rows.filter(row => row.type === section) || [];
  const hasDraft = data?.plans.some(plan => plan.status === "DRAFT") || false;
  const editable = Boolean(data?.selected?.status === "DRAFT" && data.permissions.write);
  function moveYear(offset: number) { setSelectedId(""); setYear(value => Math.min(2100, Math.max(2000, value + offset))); }
  function chooseYear(value: number) { if (Number.isInteger(value) && value >= 2000 && value <= 2100) { setSelectedId(""); setYear(value); } }
  function updateMonth(code: string, month: number, raw: string) {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    setMonthly(current => ({ ...current, [code]: Array.from({ length: 12 }, (_, index) => index === month ? value : Number(current[code]?.[index] || 0)) }));
    setDirty(true);
  }
  async function createRevision() {
    if (busy) return;
    setBusy(true);
    try { const plan = await apiRequest<BudgetPlan>("/api/budgets", { method: "POST", body: JSON.stringify({ year }) }); setSelectedId(plan._id); show(plan.revision > 1 ? `Revision ${plan.revision} created from the approved budget.` : "Budget draft created."); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not create the budget draft.", "error"); }
    finally { setBusy(false); }
  }
  async function saveDraft() {
    if (!data?.selected || !editable || busy) return;
    setBusy(true);
    try {
      const saved = await apiRequest<BudgetPlan>("/api/budgets", { method: "PATCH", body: JSON.stringify({ action: "SAVE", id: data.selected._id, expectedVersion: data.selected.version, name, notes, lines: data.rows.map(row => ({ accountCode: row.code, monthly: monthly[row.code] || Array(12).fill(0) })) }) });
      setSelectedId(saved._id); show("Budget draft saved with a new optimistic version."); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not save the budget draft.", "error"); }
    finally { setBusy(false); }
  }
  async function approve() {
    if (!data?.selected || !data.permissions.approve || data.selected.status !== "DRAFT" || busy) return;
    if (dirty) { show("Save the latest budget changes before Owner approval.", "error"); return; }
    const note = window.prompt("Owner approval note (required)", "Reviewed against the operating plan.");
    if (!note || note.trim().length < 3) return;
    setBusy(true);
    try { await apiRequest("/api/budgets", { method: "PATCH", body: JSON.stringify({ action: "APPROVE", id: data.selected._id, expectedVersion: data.selected.version, note }) }); show("Budget approved and locked. Any later change must use a new revision."); setSelectedId(""); await load(); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not approve this budget.", "error"); }
    finally { setBusy(false); }
  }

  return <div className="page page-enter budgets-page">
    <PageHeader eyebrow="PLAN · APPROVE · COMPARE" title="Budgets & variance" description="Build a monthly operating plan, lock Owner-approved revisions, and compare normal-balance actuals from posted journals without rewriting the ledger." action={<div className="budget-year-switch"><button onClick={() => moveYear(-1)} aria-label="Previous year"><ChevronLeft /></button><input type="number" min="2000" max="2100" value={year} onChange={event => chooseYear(Number(event.target.value))} aria-label="Budget year" /><button onClick={() => moveYear(1)} aria-label="Next year"><ChevronRight /></button></div>} />
    {notice ? <Notice {...notice} /> : null}
    {loading ? <LoadingPanel label="Building the budget variance…" /> : data ? <>
      <section className="stat-grid budget-stat-grid">
        <StatCard label="YTD revenue" value={money.format(data.summary.revenueActual)} detail={`Budget ${money.format(data.summary.revenueBudget)}`} icon={<TrendingUp />} />
        <StatCard label="YTD expenses" value={money.format(data.summary.expenseActual)} detail={`Budget ${money.format(data.summary.expenseBudget)}`} tone="sand" icon={<TrendingDown />} />
        <StatCard label="YTD planned profit" value={money.format(data.summary.profitBudget)} detail={`${data.ytdMonths} month${data.ytdMonths === 1 ? "" : "s"} in scope`} tone="ink" icon={<Target />} />
        <StatCard label="YTD actual profit" value={money.format(data.summary.profitActual)} detail={`Variance ${money.format(data.summary.profitVariance)}`} tone={data.summary.profitVariance >= 0 ? "matcha" : "plum"} icon={<ClipboardCheck />} />
      </section>
      <section className="panel budget-control-panel">
        <header className="panel-header"><div><span className="eyebrow">CONTROLLED REVISION</span><h2>{data.selected ? data.selected.name : `${year} budget not started`}</h2></div>{data.selected ? <StatusPill value={data.selected.status} /> : null}</header>
        <div className="budget-control-row">
          <label className="field"><span>Revision</span><select value={data.selected?._id || ""} onChange={event => setSelectedId(event.target.value)}><option value="">Current draft / approved</option>{data.plans.map(plan => <option value={plan._id} key={plan._id}>R{plan.revision} · {plan.status} · {plan.name}</option>)}</select></label>
          {editable ? <><label className="field budget-name"><span>Budget name</span><input value={name} minLength={3} maxLength={100} onChange={event => { setName(event.target.value); setDirty(true); }} /></label><label className="field budget-notes"><span>Planning notes</span><input value={notes} maxLength={500} onChange={event => { setNotes(event.target.value); setDirty(true); }} /></label></> : data.selected ? <div className="budget-lock-note"><CheckCircle2 /><span><strong>Revision {data.selected.revision} · {data.selected.status}</strong><small>{data.selected.status === "APPROVED" ? `Locked by ${data.selected.approvedByName || "Owner"}. Create a revision to change the plan.` : "Historical revision retained read-only."}</small></span></div> : null}
          <div className="budget-actions">{data.permissions.write && !hasDraft ? <button className="button button-secondary" disabled={busy} onClick={() => void createRevision()}>{data.plans.length ? "Create revision" : "Start budget"}</button> : null}{editable ? <button className="button button-primary" disabled={busy || !dirty || name.trim().length < 3} onClick={() => void saveDraft()}><Save size={15} />Save draft</button> : null}{editable && data.permissions.approve ? <button className="button button-secondary" disabled={busy || dirty} title={dirty ? "Save changes before approval" : "Approve and lock this revision"} onClick={() => void approve()}><CheckCircle2 size={15} />Approve & lock</button> : null}</div>
        </div>
      </section>
      {data.selected ? <section className="panel budget-sheet-panel">
        <header className="panel-header"><div><span className="eyebrow">{year} · {data.currency} · {data.ytdMonths ? `YTD THROUGH ${MONTHS[data.ytdMonths - 1].toUpperCase()}` : "FUTURE PLAN · NO YTD ACTUAL"}</span><h2>Monthly account plan</h2></div><div className="archive-toggle"><button className={section === "REVENUE" ? "active" : ""} onClick={() => setSection("REVENUE")}>Revenue</button><button className={section === "EXPENSE" ? "active" : ""} onClick={() => setSection("EXPENSE")}>Expenses</button></div></header>
        {rows.length ? <div className="budget-table-wrap"><table className="budget-table"><thead><tr><th>Account</th>{MONTHS.map(month => <th key={month}>{month}<small>Budget / actual</small></th>)}<th>YTD<small>Budget / actual</small></th><th>Variance<small>Favourable view</small></th></tr></thead><tbody>{rows.map(row => <tr key={row.code} className={!row.active ? "budget-inactive" : ""}><th><b>{row.code}</b><span>{row.name}</span>{!row.active ? <small>Inactive account snapshot</small> : null}</th>{MONTHS.map((month, index) => <td key={month}>{editable ? <input type="number" min="0" step={10 ** -currencyFractionDigits(data.currency)} value={monthly[row.code]?.[index] || ""} onChange={event => updateMonth(row.code, index, event.target.value)} aria-label={`${row.code} ${month} budget`} /> : <strong>{money.format(row.monthlyBudget[index])}</strong>}<small>{money.format(row.monthlyActual[index])}</small></td>)}<td><strong>{money.format(row.ytd.budget)}</strong><small>{money.format(row.ytd.actual)}</small></td><td className={row.ytd.favourable ? "variance-good" : "variance-bad"}><strong>{money.format(row.ytd.performance)}</strong><small>{row.ytd.favourable ? "Favourable" : "Unfavourable"}</small></td></tr>)}</tbody></table></div> : <EmptyState title={`No ${section.toLowerCase()} accounts`} detail="Add active revenue or expense accounts in Accounting before building this section." />}
        <footer className="budget-method-note">Actuals use posted journal normal balances. Positive variance means favourable performance: revenue above budget or expenses below budget. An approved budget is management planning evidence, not a statutory forecast or guarantee.</footer>
      </section> : <EmptyState title={`Start the ${year} budget`} detail="Create a draft to enter monthly revenue and expense plans. Only the Owner can approve and lock it." action={data.permissions.write ? <button className="button button-primary" disabled={busy} onClick={() => void createRevision()}>Start budget</button> : undefined} />}
    </> : <EmptyState title="Budget workspace unavailable" detail="Reload the page or check the accounting service." />}
  </div>;
}
