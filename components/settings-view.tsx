"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, BellRing, Building2, Clock3, Globe2, History, KeyRound,
  DatabaseZap, Network, Power, Save, ShieldCheck, UserRoundCog,
} from "lucide-react";
import { apiRequest, LoadingPanel, Notice, PageHeader, useNotice } from "@/components/ui";
import type { BusinessSettings } from "@/lib/business-settings";
import { ORGANIZATION_TYPES } from "@/lib/international";
import { RegionalSettingsFields } from "@/components/regional-settings-fields";
import type { RegionalSettings } from "@/lib/regional-settings";
import { UserPicker } from "@/components/user-picker";

type SystemControl = { mode: "OPEN" | "READ_ONLY" | "CLOSED"; reason: string; reopenAt?: string | null; scannerGeneration: number };
type TransferUser = { _id: string; fullName: string; username: string; role: string };
type Transfer = { _id: string; targetName: string; executeAfter: string; status: string };
type TransferData = { pending: Transfer | null; targets: TransferUser[]; coolingPeriodHours: number };
type SettingsHistory = { _id: string; changedFields: string[]; changedByName: string; createdAt: string };
type AttachmentStorage = { configured: boolean; owner: string; repository: string; branch: string; basePath: string; tokenLast4: string; validatedAt: string | null };

export function SettingsView({ isOwner = false }: { isOwner?: boolean }) {
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [regional, setRegional] = useState<RegionalSettings | null>(null);
  const [savedCountry, setSavedCountry] = useState("");
  const [history, setHistory] = useState<SettingsHistory[]>([]);
  const [system, setSystem] = useState<SystemControl | null>(null);
  const [transfer, setTransfer] = useState<TransferData | null>(null);
  const [transferTargetIds, setTransferTargetIds] = useState<string[]>([]);
  const [attachmentStorage, setAttachmentStorage] = useState<AttachmentStorage | null>(null);
  const [busy, setBusy] = useState(false);
  const { notice, show } = useNotice();

  const loadControls = useCallback(async () => {
    try {
      const [systemData, transferData, storageData] = await Promise.all([
        apiRequest<SystemControl>("/api/system-control"),
        isOwner ? apiRequest<TransferData>("/api/ownership-transfer") : Promise.resolve(null),
        isOwner ? apiRequest<AttachmentStorage>("/api/attachment-storage") : Promise.resolve(null),
      ]);
      setSystem(systemData);
      setTransfer(transferData);
      setAttachmentStorage(storageData);
      setTransferTargetIds(current => transferData?.pending ? [] : current.filter(id => transferData?.targets.some(user => user._id === id)));
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load Owner controls.", "error");
    }
  }, [isOwner, show]);

  const loadSettings = useCallback(async () => {
    try {
      const [profile, entries] = await Promise.all([
        apiRequest<BusinessSettings>("/api/settings"),
        apiRequest<SettingsHistory[]>("/api/settings/history"),
      ]);
      setSettings(profile);
      setRegional(profile);
      setSavedCountry(profile.countryCode);
      setHistory(entries);
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load workspace settings.", "error");
    }
  }, [show]);

  useEffect(() => { void loadSettings(); void loadControls(); }, [loadControls, loadSettings]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const updated = await apiRequest<BusinessSettings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          businessName: form.get("businessName"),
          legalEntityName: form.get("legalEntityName"),
          registrationNo: form.get("registrationNo"),
          email: form.get("email"),
          phone: form.get("phone"),
          address: form.get("address"),
          countryCode: form.get("countryCode"),
          timeZone: form.get("timeZone"),
          locale: form.get("locale"),
          currency: form.get("currency"),
          acceptedCurrencies: form.getAll("acceptedCurrencies"),
          taxName: form.get("taxName"),
          taxRate: form.get("taxRate"),
          taxMode: form.get("taxMode"),
          pointsPerDollar: form.get("pointsPerDollar"),
          lowStockNotifications: form.get("lowStockNotifications") === "on",
          organizationType: form.get("organizationType"),
          franchiseBrand: form.get("franchiseBrand"),
          franchiseCode: form.get("franchiseCode"),
          parentOrganizationCode: form.get("parentOrganizationCode"),
        }),
      });
      setSettings(updated);
      show("Workspace, country and franchise settings saved. New transactions will use the new profile.");
      await loadSettings();
      window.setTimeout(() => window.location.reload(), 700);
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not save settings.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    try {
      await apiRequest("/api/profile", { method: "PATCH", body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") }) });
      target.reset();
      show("Your password has been changed.");
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change password.", "error"); }
  }

  async function systemControl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const updated = await apiRequest<SystemControl>("/api/system-control", { method: "PATCH", body: JSON.stringify({ mode: form.get("mode"), reason: form.get("reason"), reopenInMinutes: form.get("reopenInMinutes"), revokeScannerLinks: true }) });
      setSystem(updated);
      show(`Workspace changed to ${updated.mode.replace("_", " ").toLowerCase()}; scanner passes were revoked.`);
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not change system mode.", "error"); }
  }

  async function requestTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/ownership-transfer", { method: "POST", body: JSON.stringify({ targetUserId: form.get("targetUserId") }) });
      show("Ownership transfer entered the 24-hour cooling-off period.");
      await loadControls();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not request the transfer.", "error"); }
  }

  async function saveAttachmentStorage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const target = event.currentTarget;
    setBusy(true);
    const form = new FormData(target);
    try {
      const saved = await apiRequest<AttachmentStorage>("/api/attachment-storage", { method: "PATCH", body: JSON.stringify({ owner: form.get("owner"), repository: form.get("repository"), branch: form.get("branch"), basePath: form.get("basePath"), token: String(form.get("token") || "") || undefined }) });
      setAttachmentStorage(saved);
      target.reset();
      show("Private evidence repository verified and saved. The token is encrypted and never returned to the browser.");
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not verify private evidence storage.", "error"); }
    finally { setBusy(false); }
  }

  async function transferAction(action: "CANCEL" | "COMPLETE") {
    if (!transfer?.pending) return;
    try {
      await apiRequest("/api/ownership-transfer", { method: "PATCH", body: JSON.stringify({ id: transfer.pending._id, action }) });
      if (action === "COMPLETE") { window.location.assign("/login"); return; }
      show("Ownership transfer cancelled.");
      await loadControls();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not update the transfer.", "error"); }
  }

  const historyDate = settings ? new Intl.DateTimeFormat(settings.locale, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: settings.timeZone,
  }) : null;

  return <div className="page page-enter">
    <PageHeader eyebrow="WORKSPACE" title="Settings" description="Business identity, country, time zone, currencies, franchise profile and security." />
    {notice ? <Notice {...notice} /> : null}
    {!settings ? <LoadingPanel /> : <div className="settings-grid">
      <form className="panel settings-form" onSubmit={save} key={String(settings.updatedAt || "settings")}>
        <header className="settings-section-title"><Building2 /><div><h2>Business profile</h2><p>Shown on receipts, invoices and reports.</p></div></header>
        <div className="form-grid two"><label className="field"><span>Trading name</span><input name="businessName" defaultValue={settings.businessName} required /></label><label className="field"><span>Legal entity</span><input name="legalEntityName" defaultValue={settings.legalEntityName} /></label></div>
        <div className="form-grid two"><label className="field"><span>Registration number</span><input name="registrationNo" defaultValue={settings.registrationNo} /></label><label className="field"><span>Business email</span><input name="email" type="email" defaultValue={settings.email} /></label></div>
        <div className="form-grid two"><label className="field"><span>Phone</span><input name="phone" defaultValue={settings.phone} /></label><label className="field"><span>Address</span><input name="address" defaultValue={settings.address} /></label></div>

        <div className="settings-divider" />
        {regional ? <RegionalSettingsFields value={regional} onChange={setRegional} currencyLocked /> : null}
        {regional?.countryCode !== savedCountry ? <label className="check-row" key={regional?.countryCode}><input type="checkbox" required /><span>I have reviewed the new country's tax rate, pricing mode and business time zone. Historical documents will not be rewritten.</span></label> : null}

        <div className="settings-divider" />
        <header className="settings-section-title"><Network /><div><h2>Enterprise and franchise profile</h2><p>Creates a stable identity for future multi-location and group controls.</p></div></header>
        <div className="form-grid two"><label className="field"><span>Organization type</span><select name="organizationType" defaultValue={settings.organizationType}>{ORGANIZATION_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label><label className="field"><span>Franchise brand</span><input name="franchiseBrand" defaultValue={settings.franchiseBrand} placeholder="Required for franchisees" /></label></div>
        <div className="form-grid two"><label className="field"><span>Location / franchise code</span><input name="franchiseCode" defaultValue={settings.franchiseCode} placeholder="MY-KUL-001" pattern="[A-Za-z0-9_-]*" /></label><label className="field"><span>Parent organization code</span><input name="parentOrganizationCode" defaultValue={settings.parentOrganizationCode} placeholder="BRAND-HQ" pattern="[A-Za-z0-9_-]*" /></label></div>

        <div className="settings-divider" />
        <header className="settings-section-title"><BellRing /><div><h2>Ledger rules</h2><p>Applied to new transactions.</p></div></header>
        <label className="field"><span>Member points per base-currency unit</span><input name="pointsPerDollar" type="number" min="0" max="100" step="0.1" defaultValue={settings.pointsPerDollar} required /></label>
        <label className="check-row"><input name="lowStockNotifications" type="checkbox" defaultChecked={settings.lowStockNotifications} /><span><strong>Low-stock attention markers</strong><small>Highlight products at or below their reorder level.</small></span></label>
        <footer><button className="button button-primary" disabled={busy}><Save size={16} />{busy ? "Saving…" : "Save workspace"}</button></footer>
      </form>

      <aside>
        <section className="panel settings-history"><header className="settings-section-title"><History /><div><h2>Settings history</h2><p>Latest 100 audited changes.</p></div></header>{history.length ? history.slice(0, 8).map((entry) => <div key={entry._id}><strong>{entry.changedFields.join(", ")}</strong><span>{entry.changedByName} · {historyDate?.format(new Date(entry.createdAt))}</span></div>) : <p>No settings changes recorded yet.</p>}</section>
        <form className="panel password-form" onSubmit={password}><header className="settings-section-title"><KeyRound /><div><h2>Change password</h2><p>Changing it revokes every other signed-in session.</p></div></header><label className="field"><span>Current password</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label><label className="field"><span>New password</span><input name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label><small>Use 12+ characters with upper and lowercase letters and a number.</small><button className="button button-secondary">Change password</button></form>
        <div className="security-note"><ShieldCheck /><div><strong>Security baseline</strong><p>HTTP-only versioned sessions, server-enforced roles, hashed passwords, protected identity lookup and an immutable-style audit trail are active.</p></div></div>
        {isOwner && attachmentStorage ? <form className="panel attachment-storage-control" onSubmit={saveAttachmentStorage} key={`${attachmentStorage.owner}/${attachmentStorage.repository}/${attachmentStorage.validatedAt || "new"}`}><header className="settings-section-title"><DatabaseZap /><div><h2>Private evidence repository</h2><p>Owner-only GitHub storage for receipts and claim attachments.</p></div></header><div className="form-grid two"><label className="field"><span>GitHub owner</span><input name="owner" defaultValue={attachmentStorage.owner} required placeholder="organization-or-user" /></label><label className="field"><span>Private repository</span><input name="repository" defaultValue={attachmentStorage.repository} required placeholder="accounting-evidence" /></label></div><div className="form-grid two"><label className="field"><span>Branch</span><input name="branch" defaultValue={attachmentStorage.branch || "main"} required /></label><label className="field"><span>Evidence folder</span><input name="basePath" defaultValue={attachmentStorage.basePath || "konkon-evidence"} required /></label></div><label className="field"><span>Fine-grained GitHub token {attachmentStorage.configured ? `· saved ending ${attachmentStorage.tokenLast4}` : ""}</span><input name="token" type="password" autoComplete="new-password" placeholder={attachmentStorage.configured ? "Leave blank to keep the saved token" : "Required for first setup"} /></label><p className="form-hint">Select only this private repository and grant Metadata read plus Contents read/write. Files are losslessly compressed and encrypted before upload; GitHub never receives the original bytes.</p><button className="button button-primary" disabled={busy}><DatabaseZap size={15} />{busy ? "Verifying…" : attachmentStorage.configured ? "Verify & save" : "Connect private repository"}</button></form> : null}
        {isOwner && system ? <form className={`panel system-control system-${system.mode.toLowerCase()}`} onSubmit={systemControl} key={`${system.mode}-${system.scannerGeneration}`}><header className="settings-section-title"><Power /><div><h2>System control</h2><p>Current mode: <strong>{system.mode.replace("_", " ")}</strong></p></div></header><label className="field"><span>Workspace mode</span><select name="mode" defaultValue={system.mode}><option value="OPEN">Open · normal operation</option><option value="READ_ONLY">Read-only · reports and viewing only</option><option value="CLOSED">Closed · Owner/Admin controls only</option></select></label><label className="field"><span>Reason shown to staff</span><textarea name="reason" rows={2} defaultValue={system.reason} placeholder="Maintenance or security review" /></label><label className="field"><span>Automatic reopen</span><select name="reopenInMinutes" defaultValue="0"><option value="0">Manual reopen</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option></select></label><div className="system-warning"><AlertTriangle /><span>Every mode change revokes all active phone scanner links.</span></div><button className="button button-primary"><Power size={15} />Apply system mode</button></form> : null}
        {isOwner && transfer ? <section className="panel ownership-control"><header className="settings-section-title"><UserRoundCog /><div><h2>Transfer company ownership</h2><p>A protected 24-hour cooling-off workflow.</p></div></header>{transfer.pending ? <div className="transfer-pending"><Clock3 /><div><span>NEW OWNER</span><strong>{transfer.pending.targetName}</strong><small>Eligible after {historyDate?.format(new Date(transfer.pending.executeAfter))}</small></div><div><button className="button button-secondary" onClick={() => void transferAction("CANCEL")}>Cancel transfer</button><button className="button button-primary" disabled={new Date(transfer.pending.executeAfter) > new Date()} onClick={() => void transferAction("COMPLETE")}>Complete transfer</button></div></div> : <form onSubmit={requestTransfer}><label className="field"><span>New Owner account</span></label><UserPicker users={transfer.targets} value={transferTargetIds} onChange={setTransferTargetIds} name="targetUserId" label="Search by name, username, email or role" /><p className="form-hint">The current Owner becomes Admin only after the cooling period and explicit completion. Both users are signed out everywhere.</p><button className="button button-secondary" disabled={!transferTargetIds.length}>Begin 24-hour transfer</button></form>}</section> : null}
      </aside>
    </div>}
  </div>;
}
