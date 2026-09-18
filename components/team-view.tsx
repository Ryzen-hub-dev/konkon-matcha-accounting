"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, Nfc, Copy, KeyRound, LockKeyhole, RotateCcw, ShieldCheck, Trash2, UserCog, UserPlus } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { NfcControl } from "@/components/nfc-control";
import { QrImage } from "@/components/qr-image";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { USER_ROLES, type UserRole } from "@/lib/types";
import { ACCESS_AREAS, ROLE_PROFILES, accessLevel } from "@/lib/rbac";

type TeamUser = { _id: string; fullName: string; username: string; email?: string; role: UserRole; active: boolean; mustChangePassword?: boolean; selectionTokenLast4?: string };
type Audit = { _id: string; actorName: string; action: string; entityType: string; createdAt: string };
type TeamData = { users: TeamUser[]; audit: Audit[] };

function generatedPassword() {
  const bytes = new Uint32Array(3); crypto.getRandomValues(bytes);
  return `Matcha!${bytes[0].toString(36)}-${bytes[1].toString(36).toUpperCase()}-${(bytes[2] % 1000).toString().padStart(3, "0")}`;
}

export function TeamView({ actorRole }: { actorRole: UserRole }) {
  const { dateTime } = useBusiness();
  const [data, setData] = useState<TeamData>({ users: [], audit: [] });
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState("");
  const actionPending = useRef(false);
  const [password, setPassword] = useState("");
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);
  const [selectionCredential, setSelectionCredential] = useState<{ user: TeamUser; token: string } | null>(null);
  const { notice, show } = useNotice();
  const canWrite = ["OWNER", "ADMIN"].includes(actorRole);
  const manageable = (user: TeamUser) => canWrite && user.role !== "OWNER" && !(actorRole === "ADMIN" && user.role === "ADMIN");

  async function load() {
    setLoading(true);
    try { setData(await apiRequest<TeamData>("/api/users")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load access controls.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  function openCreate() { setPassword(generatedPassword()); setOpen(true); }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true);
    const form = new FormData(event.currentTarget), username = String(form.get("username"));
    try {
      await apiRequest("/api/users", { method: "POST", body: JSON.stringify({ fullName: form.get("fullName"), username, email: form.get("email"), role: form.get("role"), password }) });
      setOpen(false); setIssued({ username, password }); setPassword(""); show("Staff account generated."); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not create the account.", "error"); }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function change(user: TeamUser, method: "PATCH" | "DELETE", fields: Record<string, unknown>, message: string) {
    if (actionPending.current) return;
    actionPending.current = true; setPendingId(user._id);
    try {
      const result = await apiRequest<{ temporaryPassword?: string; selectionToken?: string }>("/api/users", { method, body: JSON.stringify({ id: user._id, ...fields }) });
      if (result.temporaryPassword) setIssued({ username: user.username, password: result.temporaryPassword });
      else if (result.selectionToken) setSelectionCredential({ user, token: result.selectionToken });
      else if (method === "DELETE") setIssued(current => current?.username === user.username ? null : current);
      show(message); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change the account.", "error"); }
    finally { actionPending.current = false; setPendingId(""); }
  }
  function deleteUser(user: TeamUser) {
    if (window.confirm(`Delete @${user.username}? Login credentials and contact details will be removed, and linked devices signed out. The username/email can be reused. Historical transactions and audit evidence are preserved.`)) void change(user, "DELETE", {}, "Account deleted. Login details released; historical records preserved.");
  }

  return <div className="page page-enter team-page">
    <PageHeader eyebrow="OWNER CONTROL" title="Team & access" description="Give each person the access they need. Disable temporarily, or delete their login and contact details." action={canWrite ? <AddButton onClick={openCreate}>Generate account</AddButton> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="access-callout"><ShieldCheck /><div><strong>Owner is the highest authority</strong><p>Only the Owner can manage Admin accounts. Deleted accounts cannot be re-enabled; their historical records stay traceable.</p></div><span>RBAC ACTIVE</span></section>
    <section className="panel role-matrix-panel"><header className="panel-header"><div><span className="eyebrow">AUTHORITATIVE ROLE POLICY</span><h2>What every role can and cannot do</h2></div><ShieldCheck /></header><div className="role-profile-row">{USER_ROLES.map((role) => <article key={role}><strong>{ROLE_PROFILES[role].label}</strong><p>{ROLE_PROFILES[role].summary}</p></article>)}</div><div className="role-matrix-scroll"><table><thead><tr><th scope="col">Area</th>{USER_ROLES.map((role) => <th scope="col" key={role}>{ROLE_PROFILES[role].label}</th>)}</tr></thead><tbody>{ACCESS_AREAS.map((area) => <tr key={area.label}><th scope="row">{area.label}</th>{USER_ROLES.map((role) => { const level = accessLevel(role, area); return <td key={role} className={`access-${level.toLowerCase()}`}>{level === "NONE" ? <LockKeyhole /> : <CheckCircle2 />}<span>{level === "NONE" ? "Locked" : level === "MANAGE" ? "Manage" : level === "USE" ? "Use" : "View"}</span></td>; })}</tr>)}</tbody></table></div><footer><span><CheckCircle2 />Manage includes viewing and operating that area.</span><span><LockKeyhole />Locked routes remain protected by the server API, not only hidden in the menu.</span></footer></section>
    <section className="team-layout">
      <article className="panel resource-panel"><header className="panel-header"><div><span className="eyebrow">STAFF DIRECTORY</span><h2>{data.users.length} accounts</h2></div><UserCog /></header>
        {loading ? <LoadingPanel /> : data.users.length ? <div className="team-list">{data.users.map(user => <article className="team-row" key={user._id} aria-label={`Account ${user.username}`} aria-busy={pendingId === user._id}>
          <div className="member-avatar">{user.fullName.split(/\s+/).map(part => part[0]).join("").slice(0, 2)}</div>
          <div className="team-identity"><strong>{user.fullName}</strong><span>@{user.username}</span>{user.email ? <span>{user.email}</span> : null}{user.mustChangePassword ? <small>Password change required</small> : null}</div>
          <StatusPill value={user.active ? "ACTIVE" : "DISABLED"} />
          {manageable(user) ? <label className="team-role"><span>Role</span><select aria-label={`Role for ${user.username}`} value={user.role} disabled={Boolean(pendingId)} onChange={event => void change(user, "PATCH", { role: event.target.value }, "Role updated; previous sessions revoked.")}><option value="ADMIN" disabled={actorRole !== "OWNER"}>Admin</option><option value="MANAGER">Manager</option><option value="ACCOUNTANT">Accountant</option><option value="CASHIER">Cashier</option></select></label> : <span className="role-label team-role">{user.role}</span>}
          {manageable(user) ? <div className="team-actions">
            <button type="button" className="button button-secondary" disabled={Boolean(pendingId)} onClick={() => void change(user, "PATCH", { action: "RESET_PASSWORD" }, "Password reset and existing sessions revoked.")}><RotateCcw size={15} />Reset password</button>
            <button type="button" className="button button-secondary" disabled={Boolean(pendingId)} onClick={() => void change(user, "PATCH", { action: "ISSUE_SELECTION_CARD" }, "Staff lookup credential issued. Any previous lookup card is now inactive.")}><Nfc size={15} />{user.selectionTokenLast4 ? "Renew lookup card" : "Issue lookup card"}</button>
            <button type="button" className="button button-secondary" disabled={Boolean(pendingId)} onClick={() => void change(user, "PATCH", { active: !user.active }, "Access updated.")}>{user.active ? "Disable" : "Enable"}</button>
            <button type="button" className="button button-quiet danger" disabled={Boolean(pendingId)} onClick={() => deleteUser(user)}><Trash2 size={15} />Delete</button>
          </div> : null}
        </article>)}</div> : <EmptyState title="No staff accounts" detail="Generate an account for a manager, accountant or cashier." />}
      </article>
      <aside className="panel audit-panel"><header className="panel-header"><div><span className="eyebrow">SECURITY LOG</span><h2>Recent activity</h2></div><Activity /></header><div className="audit-list">{data.audit.map(item => <div key={item._id}><i /><div><strong>{item.action.replaceAll(".", " · ")}</strong><span>{item.actorName} · {item.entityType}</span></div><time>{dateTime.format(new Date(item.createdAt))}</time></div>)}</div></aside>
    </section>
    <Modal open={open} onClose={() => { setOpen(false); setPassword(""); }} title="Generate staff account" kicker="OWNER CONTROL"><form className="modal-form" onSubmit={create}>
      <div className="form-grid two"><label className="field"><span>Full name</span><input name="fullName" required minLength={2} maxLength={100} autoFocus /></label><label className="field"><span>Username</span><input name="username" pattern="[A-Za-z0-9._-]+" minLength={3} maxLength={32} required /></label></div>
      <div className="form-grid two"><label className="field"><span>Email · optional</span><input name="email" type="email" maxLength={160} /></label><label className="field"><span>Role</span><select name="role" defaultValue="CASHIER"><option value="ADMIN" disabled={actorRole !== "OWNER"}>Admin</option><option value="MANAGER">Manager</option><option value="ACCOUNTANT">Accountant</option><option value="CASHIER">Cashier</option></select></label></div>
      <label className="field"><span>Temporary password</span><div className="generated-password"><KeyRound size={16} /><input value={password} onChange={event => setPassword(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" /><button type="button" onClick={() => setPassword(generatedPassword())}>Regenerate</button></div></label>
      <p className="form-hint">Share the password securely. The staff member must change it at first sign-in.</p><footer><button type="button" className="button button-secondary" onClick={() => { setOpen(false); setPassword(""); }}>Cancel</button><button className="button button-primary" disabled={busy}><UserPlus size={16} />{busy ? "Generating…" : "Generate account"}</button></footer>
    </form></Modal>
    <Modal open={Boolean(issued)} onClose={() => setIssued(null)} title="Account ready" kicker="COPY ONCE">{issued ? <div className="credentials-card"><p>These credentials will not be shown again.</p><label><span>Username</span><strong>{issued.username}</strong></label><label><span>Temporary password</span><strong>{issued.password}</strong></label><button className="button button-primary" onClick={async () => { try { await navigator.clipboard.writeText(`Username: ${issued.username}\nTemporary password: ${issued.password}`); show("Credentials copied."); } catch { show("Clipboard unavailable. Copy the credentials manually.", "error"); } }}><Copy size={16} />Copy credentials</button></div> : null}</Modal>
    <Modal open={Boolean(selectionCredential)} onClose={() => setSelectionCredential(null)} title="Staff lookup card ready" kicker="NFC + QR · NOT A LOGIN">{selectionCredential ? <div className="credentials-card staff-credential-card"><p>This credential only finds <strong>{selectionCredential.user.fullName}</strong> inside authorised staff pickers. It cannot sign in or grant permissions. Issuing another one revokes this code.</p><QrImage value={selectionCredential.token} label={`Staff lookup QR for ${selectionCredential.user.fullName}`} /><NfcControl credentialKind="STAFF" writeToken={selectionCredential.token} /><small>Write it to a dedicated NDEF-compatible NFC card, then test it in a staff search field.</small></div> : null}</Modal>
  </div>;
}
