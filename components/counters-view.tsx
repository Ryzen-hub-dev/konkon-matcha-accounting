"use client";

import { FormEvent, useEffect, useState } from "react";
import { Archive, MapPinned, Pencil, Plus, RotateCcw, Store, UserRoundCog } from "lucide-react";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import type { CounterRecord } from "@/lib/counters";
import type { LocationRecord } from "@/lib/locations";
import type { UserRole } from "@/lib/types";

type Manager = { _id: string; fullName: string; username: string; role: UserRole; active: boolean };
type TeamData = { users: Manager[] };

export function CountersView({ canManage }: { canManage: boolean }) {
  const [counters, setCounters] = useState<CounterRecord[]>([]);
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [editing, setEditing] = useState<CounterRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [managerIds, setManagerIds] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { notice, show } = useNotice();

  async function load(includeArchived = showArchived) {
    setLoading(true);
    try {
      const counterRequest = apiRequest<CounterRecord[]>(`/api/counters${includeArchived ? "?includeArchived=1" : ""}`);
      if (canManage) {
        const [counterData, locationData, teamData] = await Promise.all([counterRequest, apiRequest<LocationRecord[]>("/api/locations"), apiRequest<TeamData>("/api/users")]);
        setCounters(counterData); setLocations(locationData); setManagers(teamData.users.filter((user) => user.role === "MANAGER" && user.active));
      } else setCounters(await counterRequest);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load counters.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function openCounter(counter?: CounterRecord) {
    setEditing(counter || null); setManagerIds(counter?.managerIds || []); setAdding(!counter);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await apiRequest("/api/counters", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...(editing ? { id: editing._id } : {}), ...values, managerIds }) });
      show(editing ? "Counter updated." : "Counter added."); setEditing(null); setAdding(false); setManagerIds([]); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not save the counter.", "error"); }
    finally { setBusy(false); }
  }

  async function setActive(counter: CounterRecord, active: boolean) {
    if (!active && !window.confirm(`Archive ${counter.name}? Existing receipts keep their counter record.`)) return;
    try {
      await apiRequest("/api/counters", { method: active ? "PATCH" : "DELETE", body: JSON.stringify({ id: counter._id, ...(active ? { active: true } : {}) }) });
      show(active ? "Counter restored." : "Counter archived."); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change the counter.", "error"); }
  }

  const active = counters.filter((counter) => counter.active !== false);
  return <div className="page page-enter counters-page">
    <PageHeader eyebrow="REGISTER NETWORK" title="Counters" description="Run several tills at once and bind accountable Managers to each operating counter." action={canManage ? <div className="page-actions"><button className="button button-secondary" onClick={() => { const next = !showArchived; setShowArchived(next); void load(next); }}>{showArchived ? "Active only" : "Include archived"}</button><AddButton onClick={() => openCounter()}><Plus />New counter</AddButton></div> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><Store /><span>Active counters</span><strong>{active.length}</strong></article><article><MapPinned /><span>Locations</span><strong>{new Set(active.map((counter) => counter.locationId)).size}</strong></article><article><UserRoundCog /><span>Manager bindings</span><strong>{active.reduce((sum, counter) => sum + counter.managerIds.length, 0)}</strong></article></section>
    <section className="panel resource-panel">{loading ? <LoadingPanel label="Reading the counter network…" /> : counters.length ? <div className="data-list counter-list"><div className="data-list-head"><span>Counter</span><span>Status</span><span>Location</span><span>Managers</span><span>Actions</span></div>{counters.map((counter) => <div className={`data-row ${counter.active === false ? "is-archived" : ""}`} key={counter._id}><div><strong>{counter.code} · {counter.name}</strong><small>{counter.systemKey === "PRIMARY" ? "Primary fallback register" : "Independent register"}</small></div><StatusPill value={counter.active === false ? "ARCHIVED" : "ACTIVE"} /><div><strong>{counter.locationName}</strong><small>Sales retain this location snapshot</small></div><div className="counter-managers"><strong>{counter.managerNames.length ? counter.managerNames.join(", ") : "Unassigned"}</strong><small>{counter.managerIds.length ? `${counter.managerIds.length} accountable manager${counter.managerIds.length === 1 ? "" : "s"}` : "Owner and Admin still retain control"}</small></div>{canManage ? <div className="row-actions">{counter.active === false ? <button className="button button-secondary" onClick={() => void setActive(counter, true)}><RotateCcw />Restore</button> : <><button className="icon-button" title={`Edit ${counter.name}`} onClick={() => openCounter(counter)}><Pencil /></button>{counter.systemKey !== "PRIMARY" ? <button className="icon-button danger" title={`Archive ${counter.name}`} onClick={() => void setActive(counter, false)}><Archive /></button> : null}</>}</div> : <span>View only</span>}</div>)}</div> : <EmptyState title="No counters available" detail="Ask an Admin to create or restore a counter." />}</section>
    <Modal open={adding || Boolean(editing)} onClose={() => { setAdding(false); setEditing(null); setManagerIds([]); }} title={editing ? `Edit ${editing.name}` : "New counter"} kicker="LOCATION + MANAGER BINDING">
      <form className="modal-form wide-form" onSubmit={save} key={editing?._id || "new-counter"}>
        <div className="form-grid three"><label className="field"><span>Counter name</span><input name="name" defaultValue={editing?.name} minLength={2} maxLength={80} required autoFocus /></label><label className="field"><span>Unique code</span><input name="code" defaultValue={editing?.code} pattern="[A-Za-z0-9_-]+" minLength={2} maxLength={24} readOnly={editing?.systemKey === "PRIMARY"} required /></label><label className="field"><span>Location</span><select name="locationId" defaultValue={editing?.locationId || locations[0]?._id || ""} required>{locations.filter((location) => location.active !== false).map((location) => <option key={location._id} value={location._id}>{location.code} · {location.name}</option>)}</select></label></div>
        <fieldset className="manager-picker"><legend>Accountable Managers · optional</legend><p>Binding records responsibility; it does not expose Owner or Admin credentials.</p><div>{managers.length ? managers.map((manager) => <label key={manager._id}><input type="checkbox" checked={managerIds.includes(manager._id)} onChange={(event) => setManagerIds((current) => event.target.checked ? [...current, manager._id] : current.filter((id) => id !== manager._id))} /><span><strong>{manager.fullName}</strong><small>@{manager.username}</small></span></label>) : <small>No active Manager accounts. Create one in Team & access first.</small>}</div></fieldset>
        <footer><button type="button" className="button button-secondary" onClick={() => { setAdding(false); setEditing(null); setManagerIds([]); }}>Cancel</button><button className="button button-primary" disabled={busy || !locations.length}><Store />{busy ? "Saving…" : "Save counter"}</button></footer>
      </form>
    </Modal>
  </div>;
}
