"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, BellRing, Building2, Clock3, Globe2, History, KeyRound,
  Network, Power, Save, ShieldCheck, UserRoundCog,
} from "lucide-react";
import { apiRequest, LoadingPanel, Notice, PageHeader, useNotice } from "@/components/ui";
import type { BusinessSettings } from "@/lib/business-settings";
import { COUNTRY_PROFILES, CURRENCY_OPTIONS, countryProfile, ORGANIZATION_TYPES } from "@/lib/international";

type SystemControl = { mode: "OPEN" | "READ_ONLY" | "CLOSED"; reason: string; reopenAt?: string | null; scannerGeneration: number };
type TransferUser = { _id: string; fullName: string; username: string; role: string };
type Transfer = { _id: string; targetName: string; executeAfter: string; status: string };
type TransferData = { pending: Transfer | null; targets: TransferUser[]; coolingPeriodHours: number };
type SettingsHistory = { _id: string; changedFields: string[]; changedByName: string; createdAt: string };

export function SettingsView({ isOwner = false }: { isOwner?: boolean }) {
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [history, setHistory] = useState<SettingsHistory[]>([]);
  const [system, setSystem] = useState<SystemControl | null>(null);
  const [transfer, setTransfer] = useState<TransferData | null>(null);
  const [busy, setBusy] = useState(false);
  const { notice, show } = useNotice();

  const loadControls = useCallback(async () => {
    try {
      const [systemData, transferData] = await Promise.all([
        apiRequest<SystemControl>("/api/system-control"),
        isOwner ? apiRequest<TransferData>("/api/ownership-transfer") : Promise.resolve(null),
      ]);
      setSystem(systemData);
      setTransfer(transferData);
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
      setHistory(entries);
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load workspace settings.", "error");
    }
  }, [show]);

  useEffect(() => { void loadSettings(); void loadControls(); }, [loadControls, loadSettings]);

  function applyCountry(event: React.ChangeEvent<HTMLSelectElement>) {
    const profile = countryProfile(event.target.value);
    const form = event.currentTarget.form;
    if (!form) return;
    const setValue = (name: string, value: string) => {
      const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (field) field.value = value;
    };
    setValue("timeZone", profile.timeZone);
    setValue("locale", profile.locale);
    setValue("currency", profile.currency);
    setValue("taxName", profile.taxName);
    const accepted = form.elements.namedItem("acceptedCurrencies") as HTMLSelectElement | null;
    const baseOption = accepted ? [...accepted.options].find((option) => option.value === profile.currency) : null;
    if (baseOption) baseOption.selected = true;
  }

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
        <header className="settings-section-title"><Globe2 /><div><h2>Country, time and currency</h2><p>Used for new records; historical documents keep their original snapshot.</p></div></header>
        <div className="form-grid three">
          <label className="field"><span>Country</span><select name="countryCode" defaultValue={settings.countryCode} onChange={applyCountry}>{COUNTRY_PROFILES.map((profile) => <option key={profile.code} value={profile.code}>{profile.name}</option>)}</select></label>
          <label className="field"><span>Time zone</span><input name="timeZone" defaultValue={settings.timeZone} placeholder="Asia/Singapore" required /></label>
          <label className="field"><span>Locale</span><input name="locale" defaultValue={settings.locale} placeholder="en-SG" required /></label>
        </div>
        <div className="form-grid two">
          <label className="field"><span>Base accounting currency</span><select name="currency" defaultValue={settings.currency}>{CURRENCY_OPTIONS.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
          <label className="field"><span>Accepted settlement currencies</span><select name="acceptedCurrencies" multiple defaultValue={settings.acceptedCurrencies} size={5}>{CURRENCY_OPTIONS.map((currency) => <option key={currency}>{currency}</option>)}</select><small>Use Ctrl/Cmd to select more than one. Always include the base currency.</small></label>
        </div>

        <div className="settings-divider" />
        <header className="settings-section-title"><Network /><div><h2>Enterprise and franchise profile</h2><p>Creates a stable identity for future multi-location and group controls.</p></div></header>
        <div className="form-grid two"><label className="field"><span>Organization type</span><select name="organizationType" defaultValue={settings.organizationType}>{ORGANIZATION_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label><label className="field"><span>Franchise brand</span><input name="franchiseBrand" defaultValue={settings.franchiseBrand} placeholder="Required for franchisees" /></label></div>
        <div className="form-grid two"><label className="field"><span>Location / franchise code</span><input name="franchiseCode" defaultValue={settings.franchiseCode} placeholder="MY-KUL-001" pattern="[A-Za-z0-9_-]*" /></label><label className="field"><span>Parent organization code</span><input name="parentOrganizationCode" defaultValue={settings.parentOrganizationCode} placeholder="BRAND-HQ" pattern="[A-Za-z0-9_-]*" /></label></div>

        <div className="settings-divider" />
        <header className="settings-section-title"><BellRing /><div><h2>Ledger rules</h2><p>Applied to new transactions.</p></div></header>
        <div className="form-grid three"><label className="field"><span>Tax name</span><input name="taxName" defaultValue={settings.taxName} required /></label><label className="field"><span>Tax rate %</span><input name="taxRate" type="number" min="0" max="100" step="0.01" defaultValue={settings.taxRate} required /></label><label className="field"><span>Retail price tax</span><select name="taxMode" defaultValue={settings.taxMode}><option value="EXCLUSIVE">Add tax at checkout</option><option value="INCLUSIVE">Tax included in shelf price</option></select></label></div>
        <label className="field"><span>Member points per base-currency unit</span><input name="pointsPerDollar" type="number" min="0" max="100" step="0.1" defaultValue={settings.pointsPerDollar} required /></label>
        <label className="check-row"><input name="lowStockNotifications" type="checkbox" defaultChecked={settings.lowStockNotifications} /><span><strong>Low-stock attention markers</strong><small>Highlight products at or below their reorder level.</small></span></label>
        <footer><button className="button button-primary" disabled={busy}><Save size={16} />{busy ? "Saving…" : "Save workspace"}</button></footer>
      </form>

      <aside>
        <section className="panel settings-history"><header className="settings-section-title"><History /><div><h2>Settings history</h2><p>Latest 100 audited changes.</p></div></header>{history.length ? history.slice(0, 8).map((entry) => <div key={entry._id}><strong>{entry.changedFields.join(", ")}</strong><span>{entry.changedByName} · {historyDate?.format(new Date(entry.createdAt))}</span></div>) : <p>No settings changes recorded yet.</p>}</section>
        <form className="panel password-form" onSubmit={password}><header className="settings-section-title"><KeyRound /><div><h2>Change password</h2><p>Changing it revokes every other signed-in session.</p></div></header><label className="field"><span>Current password</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label><label className="field"><span>New password</span><input name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label><small>Use 12+ characters with upper and lowercase letters and a number.</small><button className="button button-secondary">Change password</button></form>
        <div className="security-note"><ShieldCheck /><div><strong>Security baseline</strong><p>HTTP-only versioned sessions, server-enforced roles, hashed passwords, protected identity lookup and an immutable-style audit trail are active.</p></div></div>
        {isOwner && system ? <form className={`panel system-control system-${system.mode.toLowerCase()}`} onSubmit={systemControl} key={`${system.mode}-${system.scannerGeneration}`}><header className="settings-section-title"><Power /><div><h2>System control</h2><p>Current mode: <strong>{system.mode.replace("_", " ")}</strong></p></div></header><label className="field"><span>Workspace mode</span><select name="mode" defaultValue={system.mode}><option value="OPEN">Open · normal operation</option><option value="READ_ONLY">Read-only · reports and viewing only</option><option value="CLOSED">Closed · Owner/Admin controls only</option></select></label><label className="field"><span>Reason shown to staff</span><textarea name="reason" rows={2} defaultValue={system.reason} placeholder="Maintenance or security review" /></label><label className="field"><span>Automatic reopen</span><select name="reopenInMinutes" defaultValue="0"><option value="0">Manual reopen</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option></select></label><div className="system-warning"><AlertTriangle /><span>Every mode change revokes all active phone scanner links.</span></div><button className="button button-primary"><Power size={15} />Apply system mode</button></form> : null}
        {isOwner && transfer ? <section className="panel ownership-control"><header className="settings-section-title"><UserRoundCog /><div><h2>Transfer company ownership</h2><p>A protected 24-hour cooling-off workflow.</p></div></header>{transfer.pending ? <div className="transfer-pending"><Clock3 /><div><span>NEW OWNER</span><strong>{transfer.pending.targetName}</strong><small>Eligible after {historyDate?.format(new Date(transfer.pending.executeAfter))}</small></div><div><button className="button button-secondary" onClick={() => void transferAction("CANCEL")}>Cancel transfer</button><button className="button button-primary" disabled={new Date(transfer.pending.executeAfter) > new Date()} onClick={() => void transferAction("COMPLETE")}>Complete transfer</button></div></div> : <form onSubmit={requestTransfer}><label className="field"><span>New Owner account</span><select name="targetUserId" required defaultValue=""><option value="" disabled>Select an active staff account</option>{transfer.targets.map((user) => <option key={user._id} value={user._id}>{user.fullName} · @{user.username} · {user.role}</option>)}</select></label><p className="form-hint">The current Owner becomes Admin only after the cooling period and explicit completion. Both users are signed out everywhere.</p><button className="button button-secondary" disabled={!transfer.targets.length}>Begin 24-hour transfer</button></form>}</section> : null}
      </aside>
    </div>}
  </div>;
}
