"use client";

import { useMemo, useState } from "react";
import { Nfc, Search, X } from "lucide-react";
import { NfcControl } from "@/components/nfc-control";
import { apiRequest } from "@/components/ui";
import { searchUsers, type SearchableUser } from "@/lib/user-search";
import { staffScanToken } from "@/lib/scan-codes";

export function UserPicker<T extends SearchableUser>({ users, value, onChange, multiple = false, name, label = "Search staff", empty = "No eligible staff found", disabled = false }: {
  users: readonly T[]; value: string[]; onChange: (ids: string[]) => void; multiple?: boolean; name?: string; label?: string; empty?: string; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const matches = useMemo(() => searchUsers(users, query).slice(0, 40), [query, users]);
  const selected = users.filter(user => value.includes(user._id));
  function choose(id: string) {
    if (multiple) onChange(value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
    else onChange([id]);
  }
  async function scan(code: string) {
    try {
      const user = await apiRequest<SearchableUser>("/api/staff-lookup", { method: "POST", body: JSON.stringify({ code }) });
      if (!users.some(candidate => candidate._id === user._id)) { setScanMessage(`${user.fullName} is not eligible for this selection.`); return; }
      if (multiple) onChange(value.includes(user._id) ? value : [...value, user._id]); else onChange([user._id]);
      setQuery(user.fullName); setScanMessage(`${user.fullName} selected.`); setScanOpen(false);
    } catch (reason) { setScanMessage(reason instanceof Error ? reason.message : "Could not read this staff credential."); }
  }
  return <div className="user-picker">
    {name ? value.map(id => <input type="hidden" name={name} value={id} key={id} />) : null}
    <div className="user-picker-search"><Search size={16} /><input type="search" value={query} onChange={event => { const next = event.target.value; setQuery(next); const token = staffScanToken(next); if (token) void scan(token); }} placeholder={label} aria-label={label} disabled={disabled} /><button type="button" className="icon-button" onClick={() => setScanOpen(current => !current)} aria-label="Scan staff NFC credential" disabled={disabled}><Nfc size={17} /></button></div>
    {selected.length ? <div className="user-picker-selected">{selected.map(user => <button type="button" key={user._id} disabled={disabled} onClick={() => choose(user._id)}><span>{user.fullName}</span><small>@{user.username}</small><X size={13} /></button>)}</div> : null}
    <div className="user-picker-results" role="listbox" aria-multiselectable={multiple}>{matches.length ? matches.map(user => <button type="button" role="option" aria-selected={value.includes(user._id)} className={value.includes(user._id) ? "selected" : ""} key={user._id} onClick={() => choose(user._id)} disabled={disabled}><span><strong>{user.fullName}</strong><small>@{user.username}{user.role ? ` · ${user.role}` : ""}</small></span><i>{value.includes(user._id) ? "Selected" : "Choose"}</i></button>) : <small>{empty}</small>}</div>
    {scanOpen ? <div className="user-picker-nfc"><NfcControl credentialKind="STAFF" onRead={scan} /><button type="button" className="button button-quiet" onClick={() => setScanOpen(false)}>Close NFC reader</button></div> : null}
    {scanMessage ? <p className="form-hint" aria-live="polite">{scanMessage}</p> : null}
  </div>;
}
