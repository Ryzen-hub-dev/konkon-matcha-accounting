"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Building2, Calculator, RefreshCw } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { apiRequest, EmptyState, LoadingPanel, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { dateKeyInTimeZone } from "@/lib/dates";

type Run = {
  _id: string; runNo: string; periodFrom: string; periodTo: string; reportingCurrency: string; status: string;
  totalDebit: number; totalCredit: number; eliminationCount: number; createdAt: string; createdByName: string; reviewNote: string;
  entities: Array<{ entityCode: string; entityName: string; functionalCurrency: string; translationReserve: number }>;
  rows: Array<{ accountCode: string; accountName: string; accountType: string; debit: number; credit: number; entities: string[] }>;
};
type Data = { business: { name: string; currency: string; countryCode: string; suggestedCode: string }; runs: Run[]; importSchema: string };

export function ConsolidationView({ canWrite }: { canWrite: boolean }) {
  const { profile } = useBusiness();
  const [data, setData] = useState<Data | null>(null);
  const [selected, setSelected] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const { notice, show } = useNotice();
  const today = dateKeyInTimeZone(new Date(), profile.timeZone);
  async function load() {
    try { const loaded = await apiRequest<Data>("/api/consolidations"); setData(loaded); setSelected(current => loaded.runs.find(run => run._id === current?._id) || loaded.runs[0] || null); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load consolidations.", "error"); }
  }
  useEffect(() => { void load(); }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !data) return;
    const form = new FormData(event.currentTarget);
    let importedEntities: unknown;
    let eliminations: unknown;
    try {
      importedEntities = JSON.parse(String(form.get("importedEntities") || "[]"));
      eliminations = JSON.parse(String(form.get("eliminations") || "[]"));
    } catch { show("Imported entities and eliminations must be valid JSON arrays.", "error"); return; }
    setBusy(true);
    try {
      const run = await apiRequest<Run>("/api/consolidations", { method: "POST", body: JSON.stringify({
        clientRequestId: requestId.current, periodFrom: form.get("periodFrom"), periodTo: form.get("periodTo"),
        reportingCurrency: form.get("reportingCurrency"), currentEntityCode: form.get("currentEntityCode"),
        currentEntityClosingRate: form.get("currentEntityClosingRate"), currentEntityAverageRate: form.get("currentEntityAverageRate"),
        importedEntities, eliminations, reviewNote: form.get("reviewNote"),
      }) });
      requestId.current = crypto.randomUUID(); setSelected(run); show(`${run.runNo} prepared and balanced for review.`); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not prepare the consolidation.", "error"); }
    finally { setBusy(false); }
  }
  if (!data) return <div className="page"><LoadingPanel label="Preparing group consolidation…" /></div>;
  const money = new Intl.NumberFormat(profile.locale, { style: "currency", currency: selected?.reportingCurrency || data.business.currency });
  return <div className="page page-enter consolidation-page">
    <PageHeader eyebrow="GROUP FINANCE" title="Group consolidation" description="Combine the current posted ledger with fully controlled entity trial balances, translate currencies and post balanced elimination entries." />
    {notice ? <Notice {...notice} /> : null}
    <section className="panel quotation-policy"><Building2 /><div><strong>Prepared consolidation, not a statutory group sign-off.</strong><p>Imported entities must be reviewed, fully controlled trial balances. Minority interests, purchase-price allocation, goodwill and automatic intercompany matching require accountant adjustments before external reporting.</p></div></section>
    <div className="consolidation-layout">
      {canWrite ? <form className="panel modal-form consolidation-form" onSubmit={create}><header><span className="eyebrow">NEW IMMUTABLE RUN</span><h2>Reporting scope</h2></header><div className="form-grid three"><label className="field"><span>Period from</span><input name="periodFrom" type="date" defaultValue={`${today.slice(0, 4)}-01-01`} required /></label><label className="field"><span>Period to</span><input name="periodTo" type="date" defaultValue={today} required /></label><label className="field"><span>Reporting currency</span><input name="reportingCurrency" defaultValue={data.business.currency} pattern="[A-Za-z]{3}" maxLength={3} required /></label></div><div className="form-grid three"><label className="field"><span>Current entity code</span><input name="currentEntityCode" defaultValue={data.business.suggestedCode} pattern="[A-Za-z0-9_-]+" required /></label><label className="field"><span>Closing FX rate</span><input name="currentEntityClosingRate" type="number" min="0.000001" step="any" defaultValue="1" required /></label><label className="field"><span>Average FX rate</span><input name="currentEntityAverageRate" type="number" min="0.000001" step="any" defaultValue="1" required /></label></div><label className="field"><span>Imported entity trial balances · JSON array ({data.importSchema})</span><textarea name="importedEntities" rows={8} defaultValue="[]" spellCheck={false} /></label><label className="field"><span>Elimination journals in reporting currency · JSON array</span><textarea name="eliminations" rows={6} defaultValue="[]" spellCheck={false} /></label><label className="field"><span>Reviewer scope note</span><textarea name="reviewNote" minLength={3} maxLength={500} rows={3} placeholder="Entities included, rate source and eliminations still to be reviewed" required /></label><footer><button className="button button-primary" disabled={busy}><Calculator size={16} />{busy ? "Consolidating…" : "Prepare consolidation"}</button></footer></form> : null}
      <aside className="panel consolidation-runs"><header><span className="eyebrow">RUN REGISTER</span><h2>Prepared runs</h2></header>{data.runs.length ? data.runs.map(run => <button key={run._id} className={selected?._id === run._id ? "active" : ""} onClick={() => setSelected(run)}><span><strong>{run.runNo}</strong><small>{run.periodFrom} → {run.periodTo} · {run.entities.length} entities</small></span><StatusPill value={run.status} /></button>) : <EmptyState title="No consolidation runs" detail="Prepare the first run from posted books and reviewed entity trial balances." />}</aside>
    </div>
    {selected ? <section className="panel resource-panel consolidation-result"><header className="panel-header"><div><span className="eyebrow">{selected.runNo}</span><h2>Consolidated trial balance</h2><p>{selected.reviewNote}</p></div><button className="button button-secondary" onClick={() => void load()}><RefreshCw size={15} />Refresh</button></header><div className="mini-stat-row"><article><span>Entities</span><strong>{selected.entities.length}</strong></article><article><span>Eliminations</span><strong>{selected.eliminationCount}</strong></article><article><span>Balanced total</span><strong>{money.format(selected.totalDebit)}</strong></article></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>Account</th><th>Type</th><th>Sources</th><th className="number">Debit</th><th className="number">Credit</th></tr></thead><tbody>{selected.rows.map(row => <tr key={`${row.accountType}:${row.accountCode}`}><td><strong>{row.accountCode}</strong> · {row.accountName}</td><td>{row.accountType}</td><td>{row.entities.join(", ")}</td><td className="number">{row.debit ? money.format(row.debit) : "—"}</td><td className="number">{row.credit ? money.format(row.credit) : "—"}</td></tr>)}</tbody><tfoot><tr><th colSpan={3}>Balanced total</th><th className="number">{money.format(selected.totalDebit)}</th><th className="number">{money.format(selected.totalCredit)}</th></tr></tfoot></table></div></section> : null}
  </div>;
}
