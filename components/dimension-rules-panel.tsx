"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, GitBranchPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, StatusPill, useNotice } from "@/components/ui";

type RuleSource = "POS_LOCATION" | "EXPENSE_ACCOUNT" | "PURCHASE_LOCATION";
type Dimension = { _id: string; type: "COST_CENTRE" | "PROJECT"; code: string; name: string; active: boolean };
type Target = { id: string; code: string; name: string };
type RuleAllocation = {
  percentage: number;
  costCentre: { id: string; code: string; name: string } | null;
  project: { id: string; code: string; name: string } | null;
};
type Rule = {
  _id: string; source: RuleSource; matchKey: string; matchCode: string; matchName: string;
  allocations: RuleAllocation[];
  active: boolean; version: number;
};
type RuleData = {
  permissions: { manage: boolean };
  rules: Rule[];
  dimensions: Dimension[];
  targets: { locations: Target[]; expenseAccounts: Target[] };
};
type EditorSplit = { percentage: string; costCentreId: string; projectId: string };
type RuleEditor = { mode: "CREATE" | "EDIT"; id?: string; expectedVersion?: number; source: RuleSource; matchKey: string; allocations: EditorSplit[]; active: boolean };

const sourceLabels: Record<RuleSource, string> = {
  POS_LOCATION: "POS by location",
  EXPENSE_ACCOUNT: "Expense by account",
  PURCHASE_LOCATION: "Purchasing by location",
};

function allocationLabel(allocation: RuleAllocation) {
  const dimensions = [allocation.costCentre?.code, allocation.project?.code].filter(Boolean).join(" / ");
  return `${allocation.percentage}% · ${dimensions || "Unassigned"}`;
}

export function DimensionRulesPanel({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<RuleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<RuleEditor | null>(null);
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try { setData(await apiRequest<RuleData>("/api/dimension-rules")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load allocation rules.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [refreshKey]);

  const editorState = useMemo(() => {
    if (!editor) return { total: 0, complete: false };
    const total = editor.allocations.reduce((sum, allocation) => sum + Math.round(Number(allocation.percentage || 0) * 100), 0) / 100;
    const keys = editor.allocations.map(allocation => `${allocation.costCentreId || "-"}:${allocation.projectId || "-"}`);
    const complete = editor.allocations.every(allocation => Number(allocation.percentage) > 0 && Number(allocation.percentage) <= 100 && (allocation.costCentreId || allocation.projectId))
      && Math.abs(total - 100) < 0.001
      && new Set(keys).size === keys.length;
    return { total, complete };
  }, [editor]);

  function targets(source: RuleSource) {
    return source === "EXPENSE_ACCOUNT" ? data?.targets.expenseAccounts || [] : data?.targets.locations || [];
  }
  function openCreate() {
    setEditor({ mode: "CREATE", source: "POS_LOCATION", matchKey: "", allocations: [{ percentage: "100", costCentreId: "", projectId: "" }], active: true });
  }
  function openEdit(rule: Rule) {
    setEditor({
      mode: "EDIT", id: rule._id, expectedVersion: rule.version, source: rule.source, matchKey: rule.matchKey, active: rule.active,
      allocations: rule.allocations.map(allocation => ({ percentage: String(allocation.percentage), costCentreId: allocation.costCentre?.id || "", projectId: allocation.project?.id || "" })),
    });
  }
  function updateSplit(index: number, patch: Partial<EditorSplit>) {
    setEditor(current => current ? { ...current, allocations: current.allocations.map((allocation, allocationIndex) => allocationIndex === index ? { ...allocation, ...patch } : allocation) } : current);
  }
  function addSplit() {
    setEditor(current => {
      if (!current || current.allocations.length >= 10) return current;
      const used = current.allocations.reduce((sum, allocation) => sum + Number(allocation.percentage || 0), 0);
      const remaining = Math.max(0.01, Math.round((100 - used) * 100) / 100);
      return { ...current, allocations: [...current.allocations, { percentage: String(remaining), costCentreId: "", projectId: "" }] };
    });
  }
  function removeSplit(index: number) {
    setEditor(current => current && current.allocations.length > 1 ? { ...current, allocations: current.allocations.filter((_, allocationIndex) => allocationIndex !== index) } : current);
  }
  function requestAllocations(allocations: EditorSplit[] | RuleAllocation[]) {
    return allocations.map(allocation => "costCentreId" in allocation
      ? { percentage: Number(allocation.percentage), costCentreId: allocation.costCentreId, projectId: allocation.projectId }
      : { percentage: allocation.percentage, costCentreId: allocation.costCentre?.id || "", projectId: allocation.project?.id || "" });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !editorState.complete) return;
    setBusy(true);
    try {
      const body = editor.mode === "CREATE"
        ? { source: editor.source, matchKey: editor.matchKey, allocations: requestAllocations(editor.allocations) }
        : { id: editor.id, expectedVersion: editor.expectedVersion, active: editor.active, allocations: requestAllocations(editor.allocations) };
      await apiRequest("/api/dimension-rules", { method: editor.mode === "CREATE" ? "POST" : "PATCH", body: JSON.stringify(body) });
      show(editor.mode === "CREATE" ? "Automatic allocation rule created." : "Allocation rule updated.");
      setEditor(null);
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not save the allocation rule.", "error"); }
    finally { setBusy(false); }
  }

  async function toggle(rule: Rule) {
    setBusy(true);
    try {
      await apiRequest("/api/dimension-rules", { method: "PATCH", body: JSON.stringify({ id: rule._id, expectedVersion: rule.version, active: !rule.active, allocations: requestAllocations(rule.allocations) }) });
      show(`Allocation rule ${rule.active ? "archived" : "restored"}.`);
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change the rule status.", "error"); }
    finally { setBusy(false); }
  }

  return <section className="panel dimension-rules-panel">
    {notice ? <Notice {...notice} /> : null}
    <header className="panel-header"><div><span className="eyebrow">AUTOMATIC JOURNAL CLASSIFICATION</span><h2>Allocation rules</h2></div>{data?.permissions.manage ? <button className="button button-primary" onClick={openCreate}><Plus size={15} />New rule</button> : <span className="panel-note">READ ONLY</span>}</header>
    <div className="dimension-rule-policy"><GitBranchPlus size={19} /><p>An exact source target can post to one dimension combination or split across up to ten combinations. The server distributes currency minor units exactly and snapshots the rule onto every generated journal line; POS refunds inherit the original sale classification.</p></div>
    {loading ? <LoadingPanel label="Loading allocation rules…" /> : data?.rules.length ? <div className="dimension-rule-table"><div className="dimension-rule-head"><span>Workflow</span><span>Match target</span><span>Allocation plan</span><span>Status</span><span>Action</span></div>{data.rules.map(rule => <div className="dimension-rule-row" key={rule._id}><div><strong>{sourceLabels[rule.source]}</strong><small>Exact match</small></div><div><strong>{rule.matchCode}</strong><small>{rule.matchName}</small></div><div className="dimension-rule-plan">{rule.allocations.map(allocation => <span key={`${allocation.costCentre?.id || "-"}:${allocation.project?.id || "-"}`}><strong>{allocationLabel(allocation)}</strong><small>{[allocation.costCentre?.name, allocation.project?.name].filter(Boolean).join(" / ")}</small></span>)}</div><StatusPill value={rule.active ? "ACTIVE" : "ARCHIVED"} />{data.permissions.manage ? <div className="row-actions"><button className="button button-quiet" disabled={busy} onClick={() => openEdit(rule)}><Pencil size={13} />Edit</button><button className="button button-quiet" disabled={busy} onClick={() => void toggle(rule)}>{rule.active ? <Archive size={13} /> : <ArchiveRestore size={13} />}{rule.active ? "Archive" : "Restore"}</button></div> : <span>—</span>}</div>)}</div> : <EmptyState title="No automatic allocation rules" detail="Create a rule to classify POS, expense-payment or purchase-receipt journals automatically." />}

    <Modal open={Boolean(editor)} onClose={() => { if (!busy) setEditor(null); }} title={`${editor?.mode === "EDIT" ? "Edit" : "Create"} allocation rule`} kicker="SERVER-SIDE DEFAULT">
      {editor ? <form className="modal-form dimension-rule-form" onSubmit={save}>
        <div className="form-grid two"><label className="field"><span>Workflow</span><select value={editor.source} disabled={editor.mode === "EDIT"} onChange={event => setEditor(current => current ? { ...current, source: event.target.value as RuleSource, matchKey: "" } : current)}><option value="POS_LOCATION">POS by location</option><option value="EXPENSE_ACCOUNT">Expense payment by account</option><option value="PURCHASE_LOCATION">Purchasing by location</option></select></label><label className="field"><span>Exact match target</span><select value={editor.matchKey} disabled={editor.mode === "EDIT"} required onChange={event => setEditor(current => current ? { ...current, matchKey: event.target.value } : current)}><option value="">Choose target</option>{targets(editor.source).map(target => <option key={target.id} value={target.id}>{target.code} · {target.name}</option>)}</select></label></div>
        <section className="dimension-split-editor">
          <header><div><strong>Allocation plan</strong><small>Every split needs a cost centre, project, or both.</small></div><button type="button" className="button button-secondary" disabled={busy || editor.allocations.length >= 10} onClick={addSplit}><Plus size={13} />Add split</button></header>
          <div className="dimension-split-head"><span>Percentage</span><span>Cost centre</span><span>Project</span><span></span></div>
          {editor.allocations.map((allocation, index) => <div className="dimension-split-row" key={index}>
            <label className="field"><span className="sr-only">Percentage</span><input type="number" min="0.01" max="100" step="0.01" required value={allocation.percentage} onChange={event => updateSplit(index, { percentage: event.target.value })} /><small>%</small></label>
            <label className="field"><span className="sr-only">Cost centre</span><select value={allocation.costCentreId} onChange={event => updateSplit(index, { costCentreId: event.target.value })}><option value="">Not assigned</option>{(data?.dimensions || []).filter(item => item.type === "COST_CENTRE" && (item.active || item._id === allocation.costCentreId)).map(item => <option key={item._id} value={item._id} disabled={!item.active}>{item.code} · {item.name}{item.active ? "" : " · archived"}</option>)}</select></label>
            <label className="field"><span className="sr-only">Project</span><select value={allocation.projectId} onChange={event => updateSplit(index, { projectId: event.target.value })}><option value="">Not assigned</option>{(data?.dimensions || []).filter(item => item.type === "PROJECT" && (item.active || item._id === allocation.projectId)).map(item => <option key={item._id} value={item._id} disabled={!item.active}>{item.code} · {item.name}{item.active ? "" : " · archived"}</option>)}</select></label>
            <button type="button" className="button button-quiet icon-button" aria-label={`Remove split ${index + 1}`} disabled={busy || editor.allocations.length === 1} onClick={() => removeSplit(index)}><Trash2 size={14} /></button>
          </div>)}
          <footer className={editorState.complete ? "valid" : "invalid"}><span>Total</span><strong>{editorState.total.toFixed(2)}%</strong><small>{editorState.complete ? "Ready to allocate" : "Must total exactly 100% with unique dimension combinations"}</small></footer>
        </section>
        <p className="dimension-rule-form-note">A rule affects only new postings. Existing journals keep their original snapshots. When amounts do not divide evenly, the server assigns the final minor units deterministically so debit and credit remain balanced.</p>
        <footer><button type="button" className="button button-secondary" disabled={busy} onClick={() => setEditor(null)}>Cancel</button><button className="button button-primary" disabled={busy || !editor.matchKey || !editorState.complete}>{busy ? "Saving…" : "Save rule"}</button></footer>
      </form> : null}
    </Modal>
  </section>;
}
