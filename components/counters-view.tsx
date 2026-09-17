"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Archive, Banknote, Calculator, CheckCircle2, Clock3, FileCheck2, Pencil, Plus, RotateCcw, Store,
} from "lucide-react";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { useBusiness } from "@/components/business-context";
import type { CounterRecord } from "@/lib/counters";
import { currencyFractionDigits } from "@/lib/international";
import type { LocationRecord } from "@/lib/locations";
import type { RegisterShiftRecord, RegisterShiftSummary } from "@/lib/register-shifts";
import type { UserRole } from "@/lib/types";

type Manager = { _id: string; fullName: string; username: string; role: UserRole; active: boolean };
type TeamData = { users: Manager[] };
type ShiftData = { shifts: RegisterShiftRecord[]; controlledCounterIds: string[]; cashCurrencies: string[] };

export function CountersView({ canManage, canReviewShifts, userId }: { canManage: boolean; canReviewShifts: boolean; userId: string }) {
  const { profile, dateTime } = useBusiness();
  const [counters, setCounters] = useState<CounterRecord[]>([]);
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [shifts, setShifts] = useState<RegisterShiftRecord[]>([]);
  const [controlledCounterIds, setControlledCounterIds] = useState<string[]>([]);
  const [cashCurrencies, setCashCurrencies] = useState<string[]>([profile.currency]);
  const [editing, setEditing] = useState<CounterRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [managerIds, setManagerIds] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openingCounter, setOpeningCounter] = useState<CounterRecord | null>(null);
  const [openingCash, setOpeningCash] = useState<Record<string, number>>({});
  const [openRequestId, setOpenRequestId] = useState("");
  const [closingShift, setClosingShift] = useState<RegisterShiftRecord | null>(null);
  const [countedCash, setCountedCash] = useState<Record<string, number>>({});
  const [closeNote, setCloseNote] = useState("");
  const [closeRequestId, setCloseRequestId] = useState("");
  const [reportShift, setReportShift] = useState<RegisterShiftRecord | null>(null);
  const [reviewShift, setReviewShift] = useState<RegisterShiftRecord | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const { notice, show } = useNotice();
  const activeCurrencies = useMemo(() => cashCurrencies.length ? cashCurrencies : [profile.currency], [cashCurrencies, profile.currency]);

  function currencyMoney(currency: string, amount: number) {
    return new Intl.NumberFormat(profile.locale, { style: "currency", currency }).format(amount);
  }

  async function load(includeArchived = showArchived) {
    setLoading(true);
    try {
      const counterRequest = apiRequest<CounterRecord[]>(`/api/counters${includeArchived ? "?includeArchived=1" : ""}`);
      const shiftRequest = apiRequest<ShiftData>("/api/register-shifts");
      if (canManage) {
        const [counterData, shiftData, locationData, teamData] = await Promise.all([counterRequest, shiftRequest, apiRequest<LocationRecord[]>("/api/locations"), apiRequest<TeamData>("/api/users")]);
        setCounters(counterData);
        setShifts(shiftData.shifts);
        setControlledCounterIds(shiftData.controlledCounterIds);
        setCashCurrencies(shiftData.cashCurrencies);
        setLocations(locationData);
        setManagers(teamData.users.filter((user) => user.role === "MANAGER" && user.active));
      } else {
        const [counterData, shiftData] = await Promise.all([counterRequest, shiftRequest]);
        setCounters(counterData);
        setShifts(shiftData.shifts);
        setControlledCounterIds(shiftData.controlledCounterIds);
        setCashCurrencies(shiftData.cashCurrencies);
      }
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not load counters.", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function openCounter(counter?: CounterRecord) {
    setEditing(counter || null);
    setManagerIds(counter?.managerIds || []);
    setAdding(!counter);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await apiRequest("/api/counters", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...(editing ? { id: editing._id } : {}), ...values, managerIds }) });
      show(editing ? "Counter updated." : "Counter added.");
      setEditing(null);
      setAdding(false);
      setManagerIds([]);
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not save the counter.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(counter: CounterRecord, active: boolean) {
    if (!active && !window.confirm(`Archive ${counter.name}? Existing receipts keep their counter record.`)) return;
    try {
      await apiRequest("/api/counters", { method: active ? "PATCH" : "DELETE", body: JSON.stringify({ id: counter._id, ...(active ? { active: true } : {}) }) });
      show(active ? "Counter restored." : "Counter archived.");
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not change the counter.", "error");
    }
  }

  function beginOpenShift(counter: CounterRecord) {
    setOpeningCounter(counter);
    setOpeningCash(Object.fromEntries(activeCurrencies.map((currency) => [currency, 0])));
    setOpenRequestId(crypto.randomUUID());
  }

  async function submitOpenShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!openingCounter || busy) return;
    setBusy(true);
    try {
      await apiRequest("/api/register-shifts", {
        method: "POST",
        body: JSON.stringify({ counterId: openingCounter._id, clientRequestId: openRequestId, openingCash: activeCurrencies.map((currency) => ({ currency, amount: Number(openingCash[currency] || 0) })) }),
      });
      show(`${openingCounter.name} is open for trade.`);
      setOpeningCounter(null);
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not open the register shift.", "error");
    } finally {
      setBusy(false);
    }
  }

  function beginCloseShift(shift: RegisterShiftRecord) {
    setClosingShift(shift);
    setCountedCash(Object.fromEntries(shift.activeCurrencies.map((currency) => [currency, 0])));
    setCloseNote("");
    setCloseRequestId(crypto.randomUUID());
  }

  async function submitCloseShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!closingShift || busy) return;
    setBusy(true);
    try {
      const updated = await apiRequest<RegisterShiftRecord>("/api/register-shifts", {
        method: "PATCH",
        body: JSON.stringify({ action: "CLOSE", id: closingShift._id, clientRequestId: closeRequestId, countedCash: closingShift.activeCurrencies.map((currency) => ({ currency, amount: Number(countedCash[currency] || 0) })), note: closeNote }),
      });
      show(updated.status === "PENDING_REVIEW" ? "Cash variance recorded. A Manager must review this shift." : "Shift closed and Z report locked.");
      setClosingShift(null);
      setReportShift(updated);
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not close the register shift.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function approveShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewShift || busy) return;
    setBusy(true);
    try {
      const updated = await apiRequest<RegisterShiftRecord>("/api/register-shifts", { method: "PATCH", body: JSON.stringify({ action: "APPROVE", id: reviewShift._id, note: reviewNote }) });
      show("Cash variance reviewed. The Z report is now final.");
      setReviewShift(null);
      setReviewNote("");
      setReportShift(updated);
      await load();
    } catch (reason) {
      show(reason instanceof Error ? reason.message : "Could not approve this shift.", "error");
    } finally {
      setBusy(false);
    }
  }

  const active = counters.filter((counter) => counter.active !== false);
  const openShifts = shifts.filter((shift) => shift.status === "OPEN");
  const pendingShifts = shifts.filter((shift) => shift.status === "PENDING_REVIEW");
  const closedShifts = shifts.filter((shift) => shift.status === "CLOSED").slice(0, 12);
  const report = reportShift?.status === "OPEN" ? reportShift.liveSummary : reportShift?.summary;

  return <div className="page page-enter counters-page">
    <PageHeader eyebrow="REGISTER NETWORK" title="Counters & shifts" description="Control tills, opening cash, operator accountability and locked daily Z reports." action={canManage ? <div className="page-actions"><button className="button button-secondary" onClick={() => { const next = !showArchived; setShowArchived(next); void load(next); }}>{showArchived ? "Active only" : "Include archived"}</button><AddButton onClick={() => openCounter()}><Plus />New counter</AddButton></div> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><Store /><span>Active counters</span><strong>{active.length}</strong></article><article><Clock3 /><span>Open shifts</span><strong>{openShifts.length}</strong></article><article className={pendingShifts.length ? "warn" : ""}><FileCheck2 /><span>Variance reviews</span><strong>{pendingShifts.length}</strong></article></section>

    <section className="panel register-shift-panel">
      <header className="register-section-header"><div><span className="eyebrow">TRADING CONTROL</span><h2>Register day</h2></div><p>Shift control activates permanently for a counter after its first opening.</p></header>
      {loading ? <LoadingPanel label="Reading register shifts…" /> : active.length ? <div className="register-shift-grid">{active.map((counter) => {
        const shift = openShifts.find((item) => item.counterId === counter._id);
        const pending = pendingShifts.find((item) => item.counterId === counter._id);
        const controlled = controlledCounterIds.includes(counter._id);
        const summary = shift?.liveSummary;
        return <article key={counter._id} className={pending ? "needs-review" : shift ? "is-open" : ""}>
          <header><span><small>{counter.code}</small><strong>{counter.name}</strong></span><StatusPill value={pending ? "PENDING_REVIEW" : shift ? "OPEN" : controlled ? "CLOSED" : "NOT_STARTED"} /></header>
          {shift ? <><dl><div><dt>Operator</dt><dd>{shift.openedByName}</dd></div><div><dt>Opened</dt><dd>{dateTime.format(new Date(shift.openedAt))}</dd></div>{summary ? <div><dt>Net sales</dt><dd>{currencyMoney(summary.currency, summary.netSales)}</dd></div> : null}</dl><footer>{summary ? <button className="button button-secondary" onClick={() => setReportShift(shift)}><Calculator />X report</button> : <span>Manager-only live totals</span>}{shift.openedBy === userId || canReviewShifts ? <button className="button button-primary" onClick={() => beginCloseShift(shift)}><Banknote />Count & close</button> : <span>Opened by another operator</span>}</footer></> : pending ? <><p className="register-review-copy">The drawer was counted with a variance. Trading remains locked until review.</p><footer><button className="button button-secondary" onClick={() => setReportShift(pending)}><Calculator />Review Z report</button>{canReviewShifts ? <button className="button button-primary" onClick={() => { setReviewShift(pending); setReviewNote(""); }}><CheckCircle2 />Approve variance</button> : null}</footer></> : <><p>{controlled ? "Previous shift closed. Open a new shift before the next sale or refund." : "Opening the first shift enables controlled trading for this counter."}</p><footer><button className="button button-primary" onClick={() => beginOpenShift(counter)}><Store />Open shift</button></footer></>}
        </article>;
      })}</div> : <EmptyState title="No active counters" detail="Create or restore a counter before opening a register shift." />}
    </section>

    {closedShifts.length ? <section className="panel register-history-panel"><header className="register-section-header"><div><span className="eyebrow">LOCKED RECORDS</span><h2>Recent Z reports</h2></div><p>Closed shift totals are immutable.</p></header><div className="data-list register-history-list"><div className="data-list-head"><span>Shift</span><span>Counter</span><span>Operator</span><span>Net sales</span><span>Variance</span><span>Action</span></div>{closedShifts.map((shift) => <div className="data-row" key={shift._id}><div><strong>{shift.shiftNo}</strong><small>{shift.closedAt ? dateTime.format(new Date(shift.closedAt)) : "Closed"}</small></div><div><strong>{shift.counterName}</strong><small>{shift.locationName}</small></div><div><strong>{shift.openedByName}</strong><small>Closed by {shift.closedByName || "Unknown"}</small></div><div><strong>{currencyMoney(shift.summary?.currency || profile.currency, shift.summary?.netSales || 0)}</strong><small>{shift.summary?.saleCount || 0} sales · {shift.summary?.refundCount || 0} refunds</small></div><div><strong>{shift.summary?.cashByCurrency.map((cash) => currencyMoney(cash.currency, cash.variance || 0)).join(" · ") || "—"}</strong><small>{shift.reviewedByName ? `Reviewed by ${shift.reviewedByName}` : "Balanced at close"}</small></div><button className="button button-quiet" onClick={() => setReportShift(shift)}>View Z</button></div>)}</div></section> : null}

    <section className="panel resource-panel counter-network-panel"><header className="register-section-header"><div><span className="eyebrow">CONFIGURATION</span><h2>Counter network</h2></div><p>{new Set(active.map((counter) => counter.locationId)).size} locations · {active.reduce((sum, counter) => sum + counter.managerIds.length, 0)} Manager bindings</p></header>{loading ? <LoadingPanel label="Reading the counter network…" /> : counters.length ? <div className="data-list counter-list"><div className="data-list-head"><span>Counter</span><span>Status</span><span>Location</span><span>Managers</span><span>Actions</span></div>{counters.map((counter) => <div className={`data-row ${counter.active === false ? "is-archived" : ""}`} key={counter._id}><div><strong>{counter.code} · {counter.name}</strong><small>{counter.systemKey === "PRIMARY" ? "Primary fallback register" : "Independent register"}</small></div><StatusPill value={counter.active === false ? "ARCHIVED" : "ACTIVE"} /><div><strong>{counter.locationName}</strong><small>Sales retain this location snapshot</small></div><div className="counter-managers"><strong>{counter.managerNames.length ? counter.managerNames.join(", ") : "Unassigned"}</strong><small>{counter.managerIds.length ? `${counter.managerIds.length} accountable manager${counter.managerIds.length === 1 ? "" : "s"}` : "Owner and Admin still retain control"}</small></div>{canManage ? <div className="row-actions">{counter.active === false ? <button className="button button-secondary" onClick={() => void setActive(counter, true)}><RotateCcw />Restore</button> : <><button className="icon-button" title={`Edit ${counter.name}`} onClick={() => openCounter(counter)}><Pencil /></button>{counter.systemKey !== "PRIMARY" ? <button className="icon-button danger" title={`Archive ${counter.name}`} onClick={() => void setActive(counter, false)}><Archive /></button> : null}</>}</div> : <span>View only</span>}</div>)}</div> : <EmptyState title="No counters available" detail="Ask an Admin to create or restore a counter." />}</section>

    <Modal open={adding || Boolean(editing)} onClose={() => { setAdding(false); setEditing(null); setManagerIds([]); }} title={editing ? `Edit ${editing.name}` : "New counter"} kicker="LOCATION + MANAGER BINDING"><form className="modal-form wide-form" onSubmit={save} key={editing?._id || "new-counter"}><div className="form-grid three"><label className="field"><span>Counter name</span><input name="name" defaultValue={editing?.name} minLength={2} maxLength={80} required autoFocus /></label><label className="field"><span>Unique code</span><input name="code" defaultValue={editing?.code} pattern="[A-Za-z0-9_-]+" minLength={2} maxLength={24} readOnly={editing?.systemKey === "PRIMARY"} required /></label><label className="field"><span>Location</span><select name="locationId" defaultValue={editing?.locationId || locations[0]?._id || ""} required>{locations.filter((location) => location.active !== false).map((location) => <option key={location._id} value={location._id}>{location.code} · {location.name}</option>)}</select></label></div><fieldset className="manager-picker"><legend>Accountable Managers · optional</legend><p>Binding records responsibility; it does not expose Owner or Admin credentials.</p><div>{managers.length ? managers.map((manager) => <label key={manager._id}><input type="checkbox" checked={managerIds.includes(manager._id)} onChange={(event) => setManagerIds((current) => event.target.checked ? [...current, manager._id] : current.filter((id) => id !== manager._id))} /><span><strong>{manager.fullName}</strong><small>@{manager.username}</small></span></label>) : <small>No active Manager accounts. Create one in Team & access first.</small>}</div></fieldset><footer><button type="button" className="button button-secondary" onClick={() => { setAdding(false); setEditing(null); setManagerIds([]); }}>Cancel</button><button className="button button-primary" disabled={busy || !locations.length}><Store />{busy ? "Saving…" : "Save counter"}</button></footer></form></Modal>

    <Modal open={Boolean(openingCounter)} onClose={() => setOpeningCounter(null)} title={`Open ${openingCounter?.name || "register"}`} kicker="OPENING CASH"><form className="modal-form" onSubmit={submitOpenShift}><p className="form-hint">Count the physical float before the first sale. A zero amount is valid.</p><div className="shift-cash-fields">{activeCurrencies.map((currency) => <label className="field" key={currency}><span>{currency} opening cash</span><input type="number" min="0" max="100000000" step={10 ** -currencyFractionDigits(currency)} value={openingCash[currency] ?? 0} onChange={(event) => setOpeningCash((current) => ({ ...current, [currency]: Math.max(0, Number(event.target.value)) }))} required /></label>)}</div><footer><button type="button" className="button button-secondary" onClick={() => setOpeningCounter(null)}>Cancel</button><button className="button button-primary" disabled={busy}><Store />{busy ? "Opening…" : "Open shift"}</button></footer></form></Modal>

    <Modal open={Boolean(closingShift)} onClose={() => setClosingShift(null)} title={`Close ${closingShift?.counterName || "register"}`} kicker="BLIND CASH COUNT"><form className="modal-form" onSubmit={submitCloseShift}><p className="form-hint">Enter the physical cash actually present. Expected amounts are calculated only after submission.</p><div className="shift-cash-fields">{(closingShift?.activeCurrencies || []).map((currency) => <label className="field" key={currency}><span>{currency} counted cash</span><input type="number" min="0" max="100000000" step={10 ** -currencyFractionDigits(currency)} value={countedCash[currency] ?? 0} onChange={(event) => setCountedCash((current) => ({ ...current, [currency]: Math.max(0, Number(event.target.value)) }))} required autoFocus={currency === closingShift?.activeCurrencies[0]} /></label>)}</div><label className="field"><span>Closing note · optional</span><textarea rows={3} maxLength={300} value={closeNote} onChange={(event) => setCloseNote(event.target.value)} placeholder="Handover detail, cash movement explanation, or incident note…" /></label><div className="refund-warning"><Banknote /><p>A non-zero cash variance remains locked for Manager review before this counter can reopen.</p></div><footer><button type="button" className="button button-secondary" onClick={() => setClosingShift(null)}>Cancel</button><button className="button button-primary" disabled={busy}><Calculator />{busy ? "Closing…" : "Calculate & close"}</button></footer></form></Modal>

    <Modal open={Boolean(reportShift && report)} onClose={() => setReportShift(null)} title={`${reportShift?.status === "OPEN" ? "X" : "Z"} report · ${reportShift?.counterName || "Register"}`} kicker={reportShift?.shiftNo || "SHIFT REPORT"}>{report ? <ShiftReport summary={report} shift={reportShift!} currencyMoney={currencyMoney} dateTime={dateTime} /> : null}</Modal>

    <Modal open={Boolean(reviewShift)} onClose={() => setReviewShift(null)} title="Approve cash variance" kicker={reviewShift?.shiftNo || "MANAGER REVIEW"}><form className="modal-form" onSubmit={approveShift}><div className="refund-warning"><FileCheck2 /><p>This records your identity and explanation on the immutable Z report. Counted cash cannot be changed here.</p></div><label className="field"><span>Review explanation</span><textarea rows={4} minLength={3} maxLength={300} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Verified recount, cash paid out, counting error…" required autoFocus /></label><footer><button type="button" className="button button-secondary" onClick={() => setReviewShift(null)}>Cancel</button><button className="button button-primary" disabled={busy}><CheckCircle2 />{busy ? "Approving…" : "Approve & lock Z report"}</button></footer></form></Modal>
  </div>;
}

function ShiftReport({ summary, shift, currencyMoney, dateTime }: { summary: RegisterShiftSummary; shift: RegisterShiftRecord; currencyMoney: (currency: string, amount: number) => string; dateTime: Intl.DateTimeFormat }) {
  return <div className="shift-report">
    <div className="shift-report-meta"><span><small>Opened</small><strong>{dateTime.format(new Date(shift.openedAt))}</strong></span><span><small>Operator</small><strong>{shift.openedByName}</strong></span><span><small>Status</small><StatusPill value={shift.status} /></span></div>
    <div className="shift-report-totals"><span><small>Gross sales</small><strong>{currencyMoney(summary.currency, summary.grossSales)}</strong></span><span><small>Refunds</small><strong>−{currencyMoney(summary.currency, summary.refunds)}</strong></span><span><small>Net sales</small><strong>{currencyMoney(summary.currency, summary.netSales)}</strong></span></div>
    <section><h3>Cash drawer</h3><div className="shift-report-table"><header><span>Currency</span><span>Opening</span><span>Sales</span><span>Refunds</span><span>Expected</span><span>Counted</span><span>Variance</span></header>{summary.cashByCurrency.map((cash) => <div key={cash.currency}><strong>{cash.currency}</strong><span>{currencyMoney(cash.currency, cash.openingFloat)}</span><span>{currencyMoney(cash.currency, cash.cashSales)}</span><span>−{currencyMoney(cash.currency, cash.cashRefunds)}</span><span>{currencyMoney(cash.currency, cash.expectedCash)}</span><span>{cash.countedCash === undefined ? "—" : currencyMoney(cash.currency, cash.countedCash)}</span><b className={(cash.variance || 0) ? "variance" : ""}>{cash.variance === undefined ? "—" : currencyMoney(cash.currency, cash.variance)}</b></div>)}</div></section>
    <section><h3>Payment summary</h3><div className="shift-payment-list">{summary.paymentBreakdown.map((payment) => <div key={`${payment.code}-${payment.kind}`}><span><strong>{payment.name}</strong><small>{payment.kind.replace("_", " ")} · {payment.saleCount} sales · {payment.refundCount} refunds</small></span><span><small>Sales</small><strong>{currencyMoney(summary.currency, payment.sales)}</strong></span><span><small>Refunds</small><strong>−{currencyMoney(summary.currency, payment.refunds)}</strong></span><b>{currencyMoney(summary.currency, payment.net)}</b></div>)}</div></section>
    {shift.closeNote || shift.reviewNote ? <footer>{shift.closeNote ? <p><strong>Closing note</strong>{shift.closeNote}</p> : null}{shift.reviewNote ? <p><strong>Review · {shift.reviewedByName}</strong>{shift.reviewNote}</p> : null}</footer> : null}
  </div>;
}
