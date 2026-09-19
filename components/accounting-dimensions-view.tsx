"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, BriefcaseBusiness, Building2, CircleDollarSign, Pencil, Plus, RefreshCw, Scale, Search, Tags } from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatCard, StatusPill, useNotice } from "@/components/ui";
import { useBusiness } from "@/components/business-context";
import { dateKeyInTimeZone } from "@/lib/dates";
import { DimensionRulesPanel } from "@/components/dimension-rules-panel";

type DimensionType = "COST_CENTRE" | "PROJECT";
type Dimension = { _id: string; type: DimensionType; code: string; name: string; description: string; active: boolean; version: number; createdAt: string; updatedAt: string };
type PerformanceRow = { code: string; name: string; active: boolean; assigned: boolean; revenue: number; expense: number; profit: number; activity: number; lineCount: number };
type DimensionReport = { rows: PerformanceRow[]; summary: { revenue: number; expense: number; profit: number; activity: number; unassignedActivity: number; assignmentRate: number; lineCount: number } };
type DimensionData = {
  period: { from: string; to: string; days: number; currency: string; timeZone: string };
  permissions: { manage: boolean };
  dimensions: Dimension[];
  reports: { costCentres: DimensionReport; projects: DimensionReport };
};
type Editor = { mode: "CREATE"; type: DimensionType } | { mode: "EDIT"; dimension: Dimension };

export function AccountingDimensionsView() {
  const { money, profile } = useBusiness();
  const today = dateKeyInTimeZone(new Date(), profile.timeZone);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [type, setType] = useState<DimensionType>("COST_CENTRE");
  const [data, setData] = useState<DimensionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const { notice, show } = useNotice();

  async function load(nextFrom = from, nextTo = to) {
    setLoading(true);
    try { setData(await apiRequest<DimensionData>(`/api/accounting-dimensions?from=${encodeURIComponent(nextFrom)}&to=${encodeURIComponent(nextTo)}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not build the dimension report.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(from, to); }, []);

  const report = type === "COST_CENTRE" ? data?.reports.costCentres : data?.reports.projects;
  const label = type === "COST_CENTRE" ? "Cost centre" : "Project";
  const visibleDimensions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (data?.dimensions || []).filter(item => item.type === type && (includeArchived || item.active) && (!query || `${item.code} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query)));
  }, [data, type, includeArchived, search]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      if (editor.mode === "CREATE") {
        await apiRequest("/api/accounting-dimensions", { method: "POST", body: JSON.stringify({ type: editor.type, code: form.get("code"), name: form.get("name"), description: form.get("description") }) });
        show(`${label} created.`);
      } else {
        await apiRequest("/api/accounting-dimensions", { method: "PATCH", body: JSON.stringify({ id: editor.dimension._id, expectedVersion: editor.dimension.version, name: form.get("name"), description: form.get("description"), active: editor.dimension.active }) });
        show(`${label} updated.`);
      }
      setEditor(null);
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : `Could not save the ${label.toLowerCase()}.`, "error"); }
    finally { setBusy(false); }
  }

  async function toggle(dimension: Dimension) {
    if (dimension.active && !window.confirm(`Archive ${dimension.code}? Automatic rules that use it will be disabled, and products that use it as a default must be updated before their next POS sale. Historical journals will stay unchanged.`)) return;
    setBusy(true);
    try {
      await apiRequest("/api/accounting-dimensions", { method: "PATCH", body: JSON.stringify({ id: dimension._id, expectedVersion: dimension.version, name: dimension.name, description: dimension.description, active: !dimension.active }) });
      show(`${dimension.code} ${dimension.active ? "archived" : "restored"}. Historical journal snapshots are unchanged.`);
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change the dimension status.", "error"); }
    finally { setBusy(false); }
  }

  const summary = report?.summary || { revenue: 0, expense: 0, profit: 0, activity: 0, unassignedActivity: 0, assignmentRate: 100, lineCount: 0 };
  return <div className="page page-enter accounting-dimensions-page">
    <PageHeader eyebrow="MANAGEMENT ACCOUNTING" title="Cost centres & projects" description="Tag journal lines with stable management dimensions, then compare revenue, expense and profit without changing the statutory ledger." action={data?.permissions.manage ? <button className="button button-primary" onClick={() => setEditor({ mode: "CREATE", type })}><Plus size={16} />New {label.toLowerCase()}</button> : undefined} />
    {notice ? <Notice {...notice} /> : null}

    <section className="dimension-toolbar panel">
      <div className="dimension-tabs" role="tablist" aria-label="Dimension type">
        <button className={type === "COST_CENTRE" ? "active" : ""} onClick={() => setType("COST_CENTRE")}><Building2 size={16} />Cost centres</button>
        <button className={type === "PROJECT" ? "active" : ""} onClick={() => setType("PROJECT")}><BriefcaseBusiness size={16} />Projects</button>
      </div>
      <label className="field"><span>From</span><input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label className="field"><span>To</span><input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
      <button className="button button-secondary" disabled={loading || from > to} onClick={() => void load()}><RefreshCw size={15} />Run report</button>
    </section>

    <section className="stat-grid dimension-stat-grid">
      <StatCard label="Revenue" value={money.format(summary.revenue)} detail={`${summary.lineCount} classified P&L lines`} icon={<CircleDollarSign />} />
      <StatCard label="Expenses" value={money.format(summary.expense)} detail={`${data?.period.days || 0} days in period`} tone="sand" icon={<Scale />} />
      <StatCard label="Profit / (loss)" value={money.format(summary.profit)} detail={`${data?.period.from || from} — ${data?.period.to || to}`} tone={summary.profit >= 0 ? "ink" : "plum"} icon={<BriefcaseBusiness />} />
      <StatCard label="Assignment coverage" value={`${summary.assignmentRate.toFixed(1)}%`} detail={`${money.format(summary.unassignedActivity)} unassigned activity`} tone={summary.assignmentRate >= 95 ? "matcha" : "plum"} icon={<Tags />} />
    </section>

    <section className="dimension-layout">
      <article className="panel dimension-report-panel">
        <header className="panel-header"><div><span className="eyebrow">POSTED LEDGER PERFORMANCE</span><h2>{label} profit view</h2></div><span className="panel-note">NORMAL BALANCES</span></header>
        {loading ? <LoadingPanel label="Building dimension performance…" /> : report?.rows.length ? <div className="dimension-report-table"><div className="dimension-report-head"><span>{label}</span><span>Revenue</span><span>Expense</span><span>Profit</span><span>Lines</span></div>{report.rows.map(row => <div className={`dimension-report-row ${row.assigned ? "" : "unassigned"}`} key={row.code}><div><strong>{row.code}</strong><small>{row.name}{!row.active && row.assigned ? " · archived" : ""}</small></div><strong>{money.format(row.revenue)}</strong><strong>{money.format(row.expense)}</strong><strong className={row.profit >= 0 ? "positive" : "negative"}>{money.format(row.profit)}</strong><span>{row.lineCount}</span></div>)}</div> : <EmptyState title={`No ${label.toLowerCase()} activity`} detail="Create a dimension and assign it to revenue or expense lines in a manual journal." />}
        <footer className="dimension-report-footnote">Only posted revenue and expense journal lines are included. Unassigned activity remains visible so the report never implies complete coverage when dimensions were omitted.</footer>
      </article>

      <aside className="panel dimension-master-panel">
        <header className="panel-header"><div><span className="eyebrow">DIMENSION DIRECTORY</span><h2>{type === "COST_CENTRE" ? "Cost centres" : "Projects"}</h2></div><span className="panel-note">{visibleDimensions.length} SHOWN</span></header>
        <div className="dimension-master-tools"><label><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${label.toLowerCase()}s`} /></label><button className={`button button-quiet ${includeArchived ? "active" : ""}`} onClick={() => setIncludeArchived(value => !value)}>{includeArchived ? "Active only" : "Include archived"}</button></div>
        {visibleDimensions.length ? <div className="dimension-master-list">{visibleDimensions.map(dimension => <article key={dimension._id}><div><strong>{dimension.code} · {dimension.name}</strong><small>{dimension.description || "No description"}</small></div><StatusPill value={dimension.active ? "ACTIVE" : "ARCHIVED"} />{data?.permissions.manage ? <div className="row-actions"><button className="button button-quiet" disabled={busy} onClick={() => setEditor({ mode: "EDIT", dimension })}><Pencil size={13} />Edit</button><button className="button button-quiet" disabled={busy} onClick={() => void toggle(dimension)}>{dimension.active ? <Archive size={13} /> : <ArchiveRestore size={13} />}{dimension.active ? "Archive" : "Restore"}</button></div> : null}</article>)}</div> : <EmptyState title={`No ${label.toLowerCase()}s found`} detail={includeArchived ? "Change the search or create a new dimension." : "Create one or include archived records."} />}
      </aside>
    </section>
    <DimensionRulesPanel refreshKey={(data?.dimensions || []).map(item => `${item._id}:${item.version}:${item.active}`).join("|")} />

    <Modal open={Boolean(editor)} onClose={() => { if (!busy) setEditor(null); }} title={`${editor?.mode === "EDIT" ? "Edit" : "Create"} ${label.toLowerCase()}`} kicker="TRACKING DIMENSION">
      {editor ? <form className="modal-form dimension-editor-form" onSubmit={save} key={editor.mode === "EDIT" ? editor.dimension._id : editor.type}>
        <div className="form-grid two"><label className="field"><span>Type</span><input value={editor.mode === "EDIT" ? editor.dimension.type.replace("_", " ") : editor.type.replace("_", " ")} disabled /></label><label className="field"><span>Code</span><input name="code" defaultValue={editor.mode === "EDIT" ? editor.dimension.code : ""} minLength={2} maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" disabled={editor.mode === "EDIT"} required /><small>Code becomes permanent so historical snapshots stay comparable.</small></label></div>
        <label className="field"><span>Name</span><input name="name" defaultValue={editor.mode === "EDIT" ? editor.dimension.name : ""} minLength={2} maxLength={100} required /></label>
        <label className="field"><span>Description · optional</span><textarea name="description" defaultValue={editor.mode === "EDIT" ? editor.dimension.description : ""} maxLength={240} rows={3} /></label>
        <footer><button type="button" className="button button-secondary" disabled={busy} onClick={() => setEditor(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : "Save dimension"}</button></footer>
      </form> : null}
    </Modal>
  </div>;
}
