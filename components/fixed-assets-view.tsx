"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarCheck2, Eye, Laptop, Plus, Search, ShieldCheck, Trash2, TrendingDown } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { fixedAssetDepreciationDue, nextFixedAssetDepreciationPeriod } from "@/lib/fixed-assets";
import { formatCalendarDate } from "@/lib/dates";

type Account = { _id: string; code: string; name: string; type: "ASSET" | "EXPENSE" | "REVENUE"; cashEquivalent?: boolean };
type Asset = {
  _id: string; assetNo: string; acquisitionMode: string; name: string; category: string; serialNo?: string; location?: string; custodian?: string;
  purchaseDate: string; inServiceDate: string; cost: number; residualValue: number; usefulLifeMonths: number;
  accumulatedDepreciation: number; netBookValue: number; lastDepreciationPeriod?: string; openingThroughPeriod?: string;
  assetAccountCode: string; accumulatedDepreciationAccountCode: string; depreciationExpenseAccountCode: string;
  gainAccountCode: string; lossAccountCode: string; supplierReference?: string; notes?: string; status: string; updatedAt: string;
  disposalSnapshot?: { disposalNo: string; disposalDate: string; proceeds: number; netBookValue: number; gain: number; loss: number; entryNo: string };
};
type Run = { _id: string; runNo: string; periodKey: string; assetCount: number; total: number; entryNo: string; createdByName: string; createdAt: string };
type Depreciation = { _id: string; periodKey: string; amount: number; accumulatedDepreciation: number; netBookValue: number; entryNo: string; postedAt: string };
type Data = { assets: Asset[]; accounts: Account[]; runs: Run[]; currency: string; timeZone: string; today: string; currentPeriodKey: string };
type Detail = { asset: Asset; depreciation: Depreciation[] };

export function FixedAssetsView({ canWrite }: { canWrite: boolean }) {
  const { profile } = useBusiness();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [adding, setAdding] = useState(false);
  const [depreciating, setDepreciating] = useState(false);
  const [disposing, setDisposing] = useState<Asset | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try { setData(await apiRequest<Data>("/api/fixed-assets")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load fixed assets.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function openDetail(id: string) {
    setDetailLoading(true);
    try { setDetail(await apiRequest<Detail>(`/api/fixed-assets?id=${encodeURIComponent(id)}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not open this asset.", "error"); }
    finally { setDetailLoading(false); }
  }

  const assets = data?.assets || [];
  const needle = search.trim().toLocaleLowerCase();
  const visible = useMemo(() => assets.filter(asset => (filter === "ALL" || asset.status === filter)
    && [asset.assetNo, asset.name, asset.category, asset.serialNo, asset.location, asset.custodian].join(" ").toLocaleLowerCase().includes(needle)), [assets, filter, needle]);
  const active = assets.filter(asset => asset.status === "ACTIVE");
  const due = data ? active.filter(asset => fixedAssetDepreciationDue(asset, data.currentPeriodKey, data.currency)) : [];
  const netBookValue = assets.filter(asset => asset.status !== "DISPOSED").reduce((sum, asset) => sum + Number(asset.netBookValue || 0), 0);
  const money = new Intl.NumberFormat(profile.locale, { style: "currency", currency: data?.currency || profile.currency });

  return <div className="page page-enter fixed-assets-page">
    <PageHeader eyebrow="ASSET CONTROL" title="Fixed assets" description="Keep an auditable asset register, post straight-line book depreciation month by month, and recognise disposal gains or losses in the ledger." action={canWrite ? <div className="fixed-asset-header-actions"><button className="button button-secondary" onClick={() => setDepreciating(true)}><TrendingDown size={16} />Run depreciation</button><AddButton onClick={() => setAdding(true)}>Register asset</AddButton></div> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row fixed-asset-stats"><article><Laptop /><span>In service</span><strong>{active.length}</strong></article><article><BarChart3 /><span>Net book value</span><strong>{money.format(netBookValue)}</strong></article><article><CalendarCheck2 /><span>Due through {data?.currentPeriodKey || "current month"}</span><strong>{due.length}</strong></article></section>
    <section className="panel fixed-asset-policy"><ShieldCheck /><div><strong>Book depreciation is controlled evidence, not a tax capital-allowance calculation.</strong><p>Every month posts sequentially into the general ledger. Register-only imports do not recreate an acquisition journal; disposal requires depreciation through the disposal month and preserves the cost, accumulated depreciation, proceeds and gain/loss snapshot.</p></div></section>
    <section className="panel resource-panel fixed-asset-register">
      <div className="quotation-toolbar"><label className="field"><span><Search size={14} />Search assets</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Asset number, name, serial or location" /></label><label className="field"><span>Status</span><select value={filter} onChange={event => setFilter(event.target.value)}>{["ALL", "ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"].map(value => <option key={value} value={value}>{value === "ALL" ? "All statuses" : value.replaceAll("_", " ")}</option>)}</select></label><button className="button button-secondary" disabled={loading} onClick={() => void load()}>Refresh</button></div>
      {loading ? <LoadingPanel label="Preparing the asset register…" /> : visible.length ? <div className="data-list fixed-asset-list"><div className="data-list-head"><span>Asset</span><span>Class & location</span><span>In service</span><span>Cost</span><span>Accumulated / NBV</span><span>Status</span><span>Actions</span></div>{visible.map(asset => <div className="data-row" key={asset._id}><div><strong>{asset.assetNo} · {asset.name}</strong><small>{asset.serialNo || asset.acquisitionMode.replaceAll("_", " ")}</small></div><div><strong>{asset.category}</strong><small>{[asset.location, asset.custodian].filter(Boolean).join(" · ") || "No assignment"}</small></div><div><strong>{formatCalendarDate(asset.inServiceDate, profile.locale)}</strong><small>{asset.lastDepreciationPeriod ? `Depreciated through ${asset.lastDepreciationPeriod}` : `Next ${nextFixedAssetDepreciationPeriod(asset)}`}</small></div><strong>{money.format(asset.cost)}</strong><div><strong>{money.format(asset.accumulatedDepreciation)}</strong><small>NBV {money.format(asset.netBookValue)}</small></div><StatusPill value={asset.status} /><div className="row-actions"><button className="button button-secondary" onClick={() => void openDetail(asset._id)}><Eye size={14} />History</button>{canWrite && asset.status !== "DISPOSED" ? <button className="button button-quiet" onClick={() => setDisposing(asset)}><Trash2 size={14} />Dispose</button> : null}</div></div>)}</div> : <EmptyState title="No fixed assets" detail="Register equipment, fixtures, devices or other long-lived assets to begin monthly book depreciation." action={canWrite ? <AddButton onClick={() => setAdding(true)}>Register asset</AddButton> : undefined} />}
    </section>
    {data?.runs.length ? <section className="panel fixed-asset-runs"><header><TrendingDown /><div><strong>Recent depreciation runs</strong><small>Consolidated journal evidence</small></div></header><div>{data.runs.map(run => <article key={run._id}><span><strong>{run.runNo}</strong><small>{run.periodKey} · {run.assetCount} asset{run.assetCount === 1 ? "" : "s"}</small></span><span><strong>{money.format(run.total)}</strong><small>{run.entryNo} · {run.createdByName}</small></span></article>)}</div></section> : null}
    {adding && data ? <AssetForm data={data} onClose={() => setAdding(false)} onCreated={async asset => { setAdding(false); show(`${asset.assetNo} registered${asset.acquisitionMode === "CASH_PURCHASE" ? " and acquisition posted" : " without an acquisition journal"}.`); await load(); }} /> : null}
    {depreciating && data ? <DepreciationForm data={data} onClose={() => setDepreciating(false)} onCreated={async run => { setDepreciating(false); show(`${run.runNo} posted for ${run.assetCount} asset${run.assetCount === 1 ? "" : "s"}.`); await load(); }} /> : null}
    {disposing && data ? <DisposalForm asset={disposing} data={data} onClose={() => setDisposing(null)} onCreated={async disposal => { setDisposing(null); show(`${disposal.disposalNo} posted. The asset register and ledger are updated.`); await load(); }} /> : null}
    <Modal open={detailLoading && !detail} onClose={() => setDetailLoading(false)} title="Loading asset history" kicker="FIXED ASSET"><LoadingPanel label="Reading depreciation evidence…" /></Modal>
    {detail ? <AssetHistory detail={detail} currency={data?.currency || profile.currency} onClose={() => setDetail(null)} /> : null}
  </div>;
}

function AssetForm({ data, onClose, onCreated }: { data: Data; onClose: () => void; onCreated: (asset: Asset) => void | Promise<void> }) {
  const [mode, setMode] = useState("CASH_PURCHASE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try { await onCreated(await apiRequest<Asset>("/api/fixed-assets", { method: "POST", body: JSON.stringify({ ...payload, clientRequestId: requestId, acquisitionMode: mode }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not register this asset."); }
    finally { setBusy(false); }
  }
  const assetAccounts = data.accounts.filter(account => account.type === "ASSET" && !account.cashEquivalent);
  const cashAccounts = data.accounts.filter(account => account.type === "ASSET" && account.cashEquivalent);
  const expenseAccounts = data.accounts.filter(account => account.type === "EXPENSE");
  const revenueAccounts = data.accounts.filter(account => account.type === "REVENUE");
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Register fixed asset" kicker="ASSET REGISTER"><form className="modal-form wide-form fixed-asset-form" onSubmit={submit}>{error ? <div className="invoice-form-error" role="alert">{error}</div> : null}<fieldset disabled={busy}><div className="form-grid two"><label className="field"><span>Registration mode</span><select value={mode} onChange={event => setMode(event.target.value)}><option value="CASH_PURCHASE">New cash / bank purchase</option><option value="REGISTER_ONLY">Existing ledger asset</option></select></label><label className="field"><span>Category</span><input name="category" minLength={2} maxLength={60} required placeholder="Equipment" /></label><label className="field span-two"><span>Asset name</span><input name="name" minLength={2} maxLength={120} required placeholder="Matcha grinder" /></label><label className="field"><span>Serial number</span><input name="serialNo" maxLength={80} /></label><label className="field"><span>Supplier / document ref.</span><input name="supplierReference" maxLength={100} /></label><label className="field"><span>Location</span><input name="location" maxLength={100} placeholder="HQ counter" /></label><label className="field"><span>Custodian</span><input name="custodian" maxLength={100} placeholder="Store manager" /></label></div><div className="form-grid four"><label className="field"><span>Purchase date</span><input name="purchaseDate" type="date" max={data.today} defaultValue={data.today} required /></label><label className="field"><span>In-service date</span><input name="inServiceDate" type="date" defaultValue={data.today} required /></label><label className="field"><span>Cost ({data.currency})</span><input name="cost" type="number" min="0.01" step="any" required /></label><label className="field"><span>Residual value</span><input name="residualValue" type="number" min="0" step="any" defaultValue="0" required /></label><label className="field"><span>Useful life (months)</span><input name="usefulLifeMonths" type="number" min="1" max="600" defaultValue="60" required /></label>{mode === "REGISTER_ONLY" ? <><label className="field"><span>Opening accumulated depreciation</span><input name="openingAccumulatedDepreciation" type="number" min="0" step="any" defaultValue="0" required /></label><label className="field"><span>Covered through month</span><input name="openingThroughPeriod" type="month" max={previousPeriod(data.currentPeriodKey)} /></label></> : <input name="openingAccumulatedDepreciation" type="hidden" value="0" />}</div>{mode === "REGISTER_ONLY" ? <p className="fixed-asset-form-note">Register-only keeps the operational opening balance but does not create or prove an acquisition journal. Confirm the historic balance already exists in the general ledger.</p> : null}<div className="form-grid two"><AccountField name="assetAccountCode" label="Asset cost account" accounts={assetAccounts} preferred="1500" /><AccountField name="accumulatedDepreciationAccountCode" label="Accumulated depreciation" accounts={assetAccounts} preferred="1510" /><AccountField name="depreciationExpenseAccountCode" label="Depreciation expense" accounts={expenseAccounts} preferred="6300" /><AccountField name="gainAccountCode" label="Disposal gain" accounts={revenueAccounts} preferred="4300" /><AccountField name="lossAccountCode" label="Disposal loss" accounts={expenseAccounts} preferred="6400" />{mode === "CASH_PURCHASE" ? <AccountField name="paymentAccountCode" label="Paid from" accounts={cashAccounts} preferred="1010" /> : null}<label className="field span-two"><span>Notes</span><textarea name="notes" maxLength={500} rows={3} /></label></div></fieldset><footer><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}><Plus size={14} />{busy ? "Registering…" : "Register asset"}</button></footer></form></Modal>;
}

function AccountField({ name, label, accounts, preferred }: { name: string; label: string; accounts: Account[]; preferred: string }) {
  return <label className="field"><span>{label}</span><select name={name} defaultValue={accounts.some(account => account.code === preferred) ? preferred : accounts[0]?.code || ""} required>{accounts.map(account => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label>;
}

function DepreciationForm({ data, onClose, onCreated }: { data: Data; onClose: () => void; onCreated: (run: Run) => void | Promise<void> }) {
  const [periodKey, setPeriodKey] = useState(data.currentPeriodKey);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const due = data.assets.filter(asset => asset.status === "ACTIVE" && fixedAssetDepreciationDue(asset, periodKey, data.currency));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { await onCreated(await apiRequest<Run>("/api/fixed-assets", { method: "PATCH", body: JSON.stringify({ action: "RUN_DEPRECIATION", periodKey, note, clientRequestId: requestId }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not post depreciation."); }
    finally { setBusy(false); }
  }
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Run monthly depreciation" kicker="STRAIGHT-LINE BOOK DEPRECIATION"><form className="modal-form fixed-asset-action" onSubmit={submit}>{error ? <div className="invoice-form-error" role="alert">{error}</div> : null}<div className="fixed-asset-action-summary"><TrendingDown /><span><strong>{due.length} asset{due.length === 1 ? "" : "s"} due through this month</strong><small>Earlier missing months must post first. One balanced consolidated journal will be created.</small></span></div><label className="field"><span>Accounting month</span><input type="month" value={periodKey} max={data.currentPeriodKey} onChange={event => setPeriodKey(event.target.value)} required /></label><label className="field"><span>Reviewer note</span><textarea value={note} onChange={event => setNote(event.target.value)} minLength={3} maxLength={300} rows={3} required placeholder="Monthly depreciation reviewed…" /></label><footer><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || note.trim().length < 3}>{busy ? "Posting…" : "Post depreciation"}</button></footer></form></Modal>;
}

function DisposalForm({ asset, data, onClose, onCreated }: { asset: Asset; data: Data; onClose: () => void; onCreated: (disposal: { disposalNo: string }) => void | Promise<void> }) {
  const cashAccounts = data.accounts.filter(account => account.type === "ASSET" && account.cashEquivalent);
  const [proceeds, setProceeds] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const value = Number(proceeds) || 0;
  const difference = value - asset.netBookValue;
  const money = new Intl.NumberFormat("en", { style: "currency", currency: data.currency });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try { await onCreated(await apiRequest<{ disposalNo: string }>("/api/fixed-assets", { method: "PATCH", body: JSON.stringify({ ...payload, action: "DISPOSE", id: asset._id, expectedUpdatedAt: asset.updatedAt, clientRequestId: requestId }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not dispose this asset."); }
    finally { setBusy(false); }
  }
  return <Modal open onClose={() => { if (!busy) onClose(); }} title={`Dispose ${asset.assetNo}`} kicker="CONTROLLED ASSET DISPOSAL"><form className="modal-form fixed-asset-action" onSubmit={submit}>{error ? <div className="invoice-form-error" role="alert">{error}</div> : null}<div className="fixed-asset-disposal-values"><span><small>Cost</small><strong>{money.format(asset.cost)}</strong></span><span><small>Accumulated</small><strong>{money.format(asset.accumulatedDepreciation)}</strong></span><span><small>Net book value</small><strong>{money.format(asset.netBookValue)}</strong></span><span className={difference >= 0 ? "gain" : "loss"}><small>{difference >= 0 ? "Estimated gain" : "Estimated loss"}</small><strong>{money.format(Math.abs(difference))}</strong></span></div><div className="form-grid two"><label className="field"><span>Disposal date</span><input name="disposalDate" type="date" min={asset.inServiceDate.slice(0, 10)} max={data.today} defaultValue={data.today} required /></label><label className="field"><span>Proceeds ({data.currency})</span><input name="proceeds" type="number" min="0" step="any" value={proceeds} onChange={event => setProceeds(event.target.value)} required /></label>{value > 0 ? <AccountField name="proceedsAccountCode" label="Proceeds received into" accounts={cashAccounts} preferred="1010" /> : <input name="proceedsAccountCode" type="hidden" value="" />}<label className="field"><span>Reference</span><input name="reference" maxLength={100} /></label><label className="field span-two"><span>Disposal reason / approval note</span><textarea name="note" minLength={3} maxLength={300} rows={3} required /></label></div><p className="fixed-asset-form-note">Depreciation must be posted through the disposal month. This permanently removes the asset cost and accumulated depreciation from the ledger; the evidence remains in history.</p><footer><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}><Trash2 size={14} />{busy ? "Posting…" : "Post disposal"}</button></footer></form></Modal>;
}

function AssetHistory({ detail, currency, onClose }: { detail: Detail; currency: string; onClose: () => void }) {
  const money = new Intl.NumberFormat("en", { style: "currency", currency });
  const asset = detail.asset;
  return <Modal open onClose={onClose} title={`${asset.assetNo} · ${asset.name}`} kicker="ASSET HISTORY"><div className="fixed-asset-history"><div className="fixed-asset-disposal-values"><span><small>Cost</small><strong>{money.format(asset.cost)}</strong></span><span><small>Accumulated</small><strong>{money.format(asset.accumulatedDepreciation)}</strong></span><span><small>Net book value</small><strong>{money.format(asset.netBookValue)}</strong></span><span><small>Status</small><strong>{asset.status.replaceAll("_", " ")}</strong></span></div><dl><div><dt>Method</dt><dd>Straight-line · full service month</dd></div><div><dt>Useful life</dt><dd>{asset.usefulLifeMonths} months</dd></div><div><dt>Residual value</dt><dd>{money.format(asset.residualValue)}</dd></div><div><dt>Accounts</dt><dd>{asset.assetAccountCode} / {asset.accumulatedDepreciationAccountCode} / {asset.depreciationExpenseAccountCode}</dd></div></dl>{asset.disposalSnapshot ? <aside><strong>{asset.disposalSnapshot.disposalNo} · disposed {asset.disposalSnapshot.disposalDate}</strong><span>Proceeds {money.format(asset.disposalSnapshot.proceeds)} · gain {money.format(asset.disposalSnapshot.gain)} · loss {money.format(asset.disposalSnapshot.loss)} · {asset.disposalSnapshot.entryNo}</span></aside> : null}<section><header><strong>Depreciation ledger</strong><small>{detail.depreciation.length} posting{detail.depreciation.length === 1 ? "" : "s"}</small></header>{detail.depreciation.length ? detail.depreciation.map(row => <article key={row._id}><span><strong>{row.periodKey}</strong><small>{row.entryNo}</small></span><span><strong>{money.format(row.amount)}</strong><small>NBV {money.format(row.netBookValue)}</small></span></article>) : <p>No depreciation has been posted in this register.</p>}</section><footer><button className="button button-secondary" onClick={onClose}>Close</button></footer></div></Modal>;
}

function previousPeriod(periodKey: string) {
  const [year, month] = periodKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
