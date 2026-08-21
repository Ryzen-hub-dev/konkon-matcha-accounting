"use client";

import { FormEvent, useEffect, useState } from "react";
import { Archive, Building2, Globe2, MapPinned, Pencil, Plus, RotateCcw, Warehouse } from "lucide-react";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { COUNTRY_PROFILES, CURRENCY_OPTIONS, countryProfile } from "@/lib/international";
import { LOCATION_TYPES, type LocationRecord } from "@/lib/locations";

export function LocationsView() {
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [editing, setEditing] = useState<LocationRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { notice, show } = useNotice();

  async function load(includeArchived = showArchived) {
    setLoading(true);
    try { setLocations(await apiRequest<LocationRecord[]>(`/api/locations${includeArchived ? "?includeArchived=1" : ""}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load enterprise locations.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function applyCountry(event: React.ChangeEvent<HTMLSelectElement>) {
    const profile = countryProfile(event.target.value);
    const form = event.currentTarget.form;
    if (!form) return;
    for (const [name, value] of [["timeZone", profile.timeZone], ["locale", profile.locale], ["currency", profile.currency]]) {
      const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (field) field.value = value;
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await apiRequest("/api/locations", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...(editing ? { id: editing._id } : {}), ...body }) });
      show(editing ? "Location updated." : "Enterprise location added.");
      setEditing(null); setAdding(false); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not save the location.", "error"); }
    finally { setBusy(false); }
  }

  async function setActive(location: LocationRecord, active: boolean) {
    try {
      if (active) await apiRequest("/api/locations", { method: "PATCH", body: JSON.stringify({ id: location._id, active: true }) });
      else {
        if (!window.confirm(`Archive ${location.name}? Historical records will remain linked.`)) return;
        await apiRequest("/api/locations", { method: "DELETE", body: JSON.stringify({ id: location._id }) });
      }
      show(active ? "Location restored." : "Location archived.");
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change the location.", "error"); }
  }

  const selected = editing;
  const active = locations.filter((location) => location.active !== false);
  const countries = new Set(active.map((location) => location.countryCode)).size;

  return <div className="page page-enter">
    <PageHeader eyebrow="ENTERPRISE STRUCTURE" title="Locations & franchises" description="Control headquarters, branches, warehouses and franchise outlets across countries." action={<div className="page-actions"><button className="button button-secondary" onClick={() => { const next = !showArchived; setShowArchived(next); void load(next); }}>{showArchived ? "Active only" : "Include archived"}</button><AddButton onClick={() => { setEditing(null); setAdding(true); }}>New location</AddButton></div>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><Building2 /><span>Active locations</span><strong>{active.length}</strong></article><article><Globe2 /><span>Countries</span><strong>{countries}</strong></article><article><Warehouse /><span>Warehouses</span><strong>{active.filter((location) => location.type === "WAREHOUSE").length}</strong></article></section>
    <section className="panel resource-panel">{loading ? <LoadingPanel label="Reading the enterprise structure…" /> : locations.length ? <div className="data-list location-list"><div className="data-list-head"><span>Location</span><span>Type</span><span>Country / time</span><span>Currency</span><span>Parent</span><span>Actions</span></div>{locations.map((location) => <div className={`data-row ${location.active === false ? "is-archived" : ""}`} key={location._id}><div><strong>{location.code} · {location.name}</strong><small>{location.address || "No address"}</small></div><StatusPill value={location.active === false ? "ARCHIVED" : location.type} /><div><strong>{countryProfile(location.countryCode).name}</strong><small>{location.timeZone}</small></div><strong>{location.currency}</strong><span>{location.parentLocationName || "—"}</span><div className="row-actions">{location.active === false ? <button className="button button-secondary" onClick={() => void setActive(location, true)}><RotateCcw />Restore</button> : <><button className="icon-button" title="Edit location" onClick={() => { setAdding(false); setEditing(location); }}><Pencil /></button><button className="icon-button danger" title="Archive location" onClick={() => void setActive(location, false)}><Archive /></button></>}</div></div>)}</div> : <EmptyState title="No enterprise locations" detail="Add the first branch, warehouse or franchise outlet." />}</section>
    <Modal open={adding || Boolean(editing)} onClose={() => { setAdding(false); setEditing(null); }} title={selected ? `Edit ${selected.name}` : "New enterprise location"} kicker="COUNTRY + OWNERSHIP">
      <form className="modal-form wide-form" onSubmit={save} key={selected?._id || "new-location"}>
        <div className="form-grid three"><label className="field"><span>Location name</span><input name="name" defaultValue={selected?.name} required autoFocus /></label><label className="field"><span>Unique code</span><input name="code" defaultValue={selected?.code} pattern="[A-Za-z0-9_-]+" required /></label><label className="field"><span>Type</span><select name="type" defaultValue={selected?.type || "BRANCH"}>{LOCATION_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label></div>
        <div className="form-grid three"><label className="field"><span>Country</span><select name="countryCode" defaultValue={selected?.countryCode || "SG"} onChange={applyCountry}>{COUNTRY_PROFILES.map((profile) => <option key={profile.code} value={profile.code}>{profile.name}</option>)}</select></label><label className="field"><span>Time zone</span><input name="timeZone" defaultValue={selected?.timeZone || "Asia/Singapore"} required /></label><label className="field"><span>Locale</span><input name="locale" defaultValue={selected?.locale || "en-SG"} required /></label></div>
        <div className="form-grid two"><label className="field"><span>Operating currency</span><select name="currency" defaultValue={selected?.currency || "SGD"}>{CURRENCY_OPTIONS.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label className="field"><span>Parent location</span><select name="parentLocationId" defaultValue={selected?.parentLocationId || ""}><option value="">No parent</option>{active.filter((location) => location._id !== selected?._id).map((location) => <option key={location._id} value={location._id}>{location.code} · {location.name}</option>)}</select></label></div>
        <label className="field"><span>Address</span><textarea name="address" rows={3} defaultValue={selected?.address} /></label>
        <footer><button type="button" className="button button-secondary" onClick={() => { setAdding(false); setEditing(null); }}>Cancel</button><button className="button button-primary" disabled={busy}><MapPinned />{busy ? "Saving…" : "Save location"}</button></footer>
      </form>
    </Modal>
  </div>;
}
