"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { CalendarClock, CircleCheckBig, FileClock, Pause, Play, Plus, RotateCw, ShieldCheck, Square, Trash2 } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { AddButton, ApiRequestError, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { dateKeyInTimeZone, formatCalendarDate } from "@/lib/dates";
import { currencyFractionDigits, roundCurrency } from "@/lib/international";
import { calculateTaxTotals } from "@/lib/tax";

type Frequency = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
type Item = { description: string; quantity: number; unitPrice: number };
type Account = { _id: string; memberNo: string; name: string; email?: string; phone?: string; creditTermsDays?: number };
type Template = { _id: string; name: string; isDefault?: boolean };
type Dimension = { _id: string; type: "COST_CENTRE" | "PROJECT"; code: string; name: string };
type Schedule = {
  _id: string; scheduleNo: string; name: string; status: string; memberNo: string; customerName: string;
  frequency: Frequency; startDate: string; nextRunDate: string; endDate?: string; dueDays: number;
  plannedTotal: number; plannedCurrency: string; lastInvoiceId?: string; lastInvoiceNo?: string;
  lastError?: string; updatedAt: string;
};
type PageData = { schedules: Schedule[]; accounts: Account[]; templates: Template[]; dimensions: Dimension[] };
type DimensionMode = "CUSTOMER_DEFAULT" | "CUSTOM" | "NONE";
type FormState = {
  name: string; memberId: string; billingAddress: string; customerReference: string; notes: string;
  templateId: string; frequency: Frequency; startDate: string; endDate: string; dueDays: number;
  dimensionMode: DimensionMode; costCentreId: string; projectId: string; items: Item[];
};

const cadence: Record<Frequency, string> = { WEEKLY: "Weekly", MONTHLY: "Monthly", QUARTERLY: "Quarterly", YEARLY: "Yearly" };

export function RecurringInvoicesView() {
  const { profile, money } = useBusiness();
  const today = dateKeyInTimeZone(new Date(), profile.timeZone);
  const [data, setData] = useState<PageData>({ schedules: [], accounts: [], templates: [], dimensions: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const [uncertainPayload, setUncertainPayload] = useState("");
  const requestId = useRef("");
  const { notice, show } = useNotice();
  const [form, setForm] = useState<FormState>(() => ({
    name: "", memberId: "", billingAddress: "", customerReference: "", notes: "", templateId: "",
    frequency: "MONTHLY", startDate: today, endDate: "", dueDays: 14,
    dimensionMode: "CUSTOMER_DEFAULT", costCentreId: "", projectId: "",
    items: [{ description: "", quantity: 1, unitPrice: 0 }],
  }));

  async function load() {
    setLoading(true);
    try {
      const loaded = await apiRequest<PageData>("/api/recurring-invoices");
      setData(loaded);
      setForm(current => ({ ...current, templateId: current.templateId || loaded.templates.find(item => item.isDefault)?._id || loaded.templates[0]?._id || "" }));
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not load recurring invoices.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function openCreate() {
    requestId.current = crypto.randomUUID();
    setUncertainPayload(""); setError("");
    setForm({
      name: "", memberId: "", billingAddress: "", customerReference: "", notes: "",
      templateId: data.templates.find(item => item.isDefault)?._id || data.templates[0]?._id || "",
      frequency: "MONTHLY", startDate: today, endDate: "", dueDays: 14,
      dimensionMode: "CUSTOMER_DEFAULT", costCentreId: "", projectId: "",
      items: [{ description: "", quantity: 1, unitPrice: 0 }],
    });
    setCreateOpen(true);
  }
  function selectAccount(memberId: string) {
    const account = data.accounts.find(item => item._id === memberId);
    setForm(current => ({ ...current, memberId, dueDays: account?.creditTermsDays ?? current.dueDays }));
  }
  function changeItem(index: number, patch: Partial<Item>) {
    setForm(current => ({ ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  }
  async function createSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guard.current) return;
    guard.current = true; setBusy(true); setError("");
    const payload = uncertainPayload || JSON.stringify({
      name: form.name, memberId: form.memberId, billingAddress: form.billingAddress,
      customerReference: form.customerReference, notes: form.notes, templateId: form.templateId,
      frequency: form.frequency, startDate: form.startDate, endDate: form.endDate, dueDays: form.dueDays,
      items: form.items, clientRequestId: requestId.current || (requestId.current = crypto.randomUUID()),
      dimensionSelection: { mode: form.dimensionMode, costCentreId: form.costCentreId, projectId: form.projectId },
    });
    try {
      const saved = await apiRequest<Schedule>("/api/recurring-invoices", { method: "POST", body: payload });
      setCreateOpen(false); show(`${saved.scheduleNo} is active. Due runs will create reviewable drafts.`); await load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not create the schedule.";
      if (reason instanceof ApiRequestError && (reason.status === 0 || reason.status >= 500)) {
        setUncertainPayload(payload);
        setError(`${message} The result is uncertain. Retry the same save safely before changing the details.`);
      } else setError(message);
    } finally { guard.current = false; setBusy(false); }
  }
  async function runDue() {
    if (guard.current) return;
    guard.current = true; setBusy(true);
    try {
      const result = await apiRequest<{ generated: number; alreadyGenerated: number; failed: number }>("/api/recurring-invoices", { method: "PATCH", body: JSON.stringify({ action: "RUN_DUE" }) });
      show(`${result.generated} draft${result.generated === 1 ? "" : "s"} created${result.failed ? `; ${result.failed} schedule${result.failed === 1 ? "" : "s"} need attention` : ""}.`, result.failed ? "error" : "success");
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not run due schedules.", "error"); }
    finally { guard.current = false; setBusy(false); }
  }
  async function changeStatus(schedule: Schedule, action: "PAUSE" | "RESUME" | "END") {
    if (guard.current) return;
    if (action === "END" && !window.confirm(`End ${schedule.name}? Existing invoices stay intact and this schedule cannot be resumed.`)) return;
    guard.current = true; setBusy(true);
    try {
      await apiRequest("/api/recurring-invoices", { method: "PATCH", body: JSON.stringify({ action, id: schedule._id, expectedUpdatedAt: schedule.updatedAt }) });
      show(`${schedule.name} ${action === "PAUSE" ? "paused" : action === "RESUME" ? "resumed" : "ended"}.`); await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not update the schedule.", "error"); }
    finally { guard.current = false; setBusy(false); }
  }

  const active = data.schedules.filter(item => item.status === "ACTIVE").length;
  const due = data.schedules.filter(item => item.status === "ACTIVE" && item.nextRunDate <= today).length;
  const generated = data.schedules.filter(item => item.lastInvoiceId).length;
  const subtotal = roundCurrency(form.items.reduce((sum, item) => sum + roundCurrency(item.quantity * roundCurrency(item.unitPrice, profile.currency), profile.currency), 0), profile.currency);
  const totals = calculateTaxTotals(subtotal, 0, profile.taxRate, profile.taxMode, profile.currency);
  const dimensionValid = form.dimensionMode !== "CUSTOM" || Boolean(form.costCentreId || form.projectId);

  return <div className="page page-enter recurring-invoice-page">
    <PageHeader eyebrow="ACCOUNTS RECEIVABLE · AUTOMATION" title="Recurring invoices" description="Schedule repeat billing while keeping a human review between automation and the customer." action={<div className="invoice-page-actions"><Link className="button button-secondary" href="/invoices">Back to invoices</Link><AddButton onClick={openCreate}>New schedule</AddButton></div>} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row"><article><CalendarClock /><span>Active schedules</span><strong>{active}</strong></article><article><FileClock /><span>Due now</span><strong>{due}</strong></article><article><CircleCheckBig /><span>Schedules with drafts</span><strong>{generated}</strong></article></section>
    <section className="panel quotation-policy"><ShieldCheck /><div><strong>Automation stops at a draft.</strong><p>Each run uses the current business currency and tax settings, then creates one idempotent draft per due occurrence. Nothing is emailed, posted or charged until an authorised user reviews it.</p></div></section>
    <section className="panel recurring-register">
      <div className="recurring-toolbar"><div><strong>Billing cadence</strong><span>{due ? `${due} schedule${due === 1 ? " is" : "s are"} ready to run.` : "All active schedules are up to date."}</span></div><button className="button button-secondary" disabled={busy || !due} onClick={runDue}><RotateCw size={15} />{busy ? "Working…" : "Generate due drafts"}</button></div>
      {loading ? <LoadingPanel /> : data.schedules.length ? <div className="recurring-list"><div className="data-list-head"><span>Schedule</span><span>Customer</span><span>Cadence</span><span>Next run</span><span>Planned</span><span>Status</span><span>Actions</span></div>{data.schedules.map(schedule => <article className="data-row" key={schedule._id}>
        <div><strong>{schedule.name}</strong><small>{schedule.scheduleNo}</small>{schedule.lastError ? <small className="recurring-error">{schedule.lastError}</small> : null}</div>
        <div><strong>{schedule.customerName}</strong><small>{schedule.memberNo}</small></div>
        <div><strong>{cadence[schedule.frequency]}</strong><small>{schedule.dueDays} day terms</small></div>
        <div><strong>{formatCalendarDate(schedule.nextRunDate, profile.locale)}</strong><small>{schedule.endDate ? `Ends ${formatCalendarDate(schedule.endDate, profile.locale)}` : "No end date"}</small></div>
        <div><strong>{schedule.plannedCurrency === profile.currency ? money.format(schedule.plannedTotal) : `${schedule.plannedCurrency} ${schedule.plannedTotal.toFixed(2)}`}</strong>{schedule.lastInvoiceId ? <Link href={`/invoices/${schedule.lastInvoiceId}`}>{schedule.lastInvoiceNo}</Link> : <small>No draft yet</small>}</div>
        <StatusPill value={schedule.status} />
        <div className="row-actions">{schedule.status === "ACTIVE" ? <button className="button button-quiet" disabled={busy} onClick={() => changeStatus(schedule, "PAUSE")}><Pause size={14} />Pause</button> : null}{schedule.status === "PAUSED" ? <button className="button button-quiet" disabled={busy} onClick={() => changeStatus(schedule, "RESUME")}><Play size={14} />Resume</button> : null}{["ACTIVE", "PAUSED"].includes(schedule.status) ? <button className="button button-quiet" disabled={busy} onClick={() => changeStatus(schedule, "END")}><Square size={14} />End</button> : null}</div>
      </article>)}</div> : <EmptyState title="No recurring invoice schedules" detail="Create a schedule for retainers, subscriptions, rent or repeat wholesale orders. Every occurrence remains a reviewable invoice draft." action={<AddButton onClick={openCreate}>New schedule</AddButton>} />}
    </section>
    <Modal open={createOpen} onClose={() => { if (!busy && !uncertainPayload) setCreateOpen(false); }} title="Create recurring invoice" kicker="CONTROLLED AUTOMATION">
      <form className="modal-form wide-form invoice-draft-form" onSubmit={createSchedule}>
        <div className="invoice-draft-guidance"><ShieldCheck size={18} /><p>The customer account must remain active. Prices stay on this schedule; business details, currency and tax are refreshed when each draft is generated.</p></div>
        {error ? <div className="invoice-form-error" role="alert">{error}</div> : null}
        <fieldset disabled={busy || Boolean(uncertainPayload)}>
          <div className="form-grid two"><label className="field"><span>Schedule name</span><input autoFocus required minLength={2} maxLength={100} placeholder="Monthly wholesale order" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label className="field"><span>Customer account</span><select required value={form.memberId} onChange={event => selectAccount(event.target.value)}><option value="">Choose active customer</option>{data.accounts.map(account => <option value={account._id} key={account._id}>{account.memberNo} · {account.name}</option>)}</select></label></div>
          <div className="form-grid four"><label className="field"><span>Frequency</span><select value={form.frequency} onChange={event => setForm({ ...form, frequency: event.target.value as Frequency })}>{Object.entries(cadence).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>First run</span><input required type="date" value={form.startDate} onChange={event => setForm({ ...form, startDate: event.target.value })} /></label><label className="field"><span>End date · optional</span><input type="date" min={form.startDate} value={form.endDate} onChange={event => setForm({ ...form, endDate: event.target.value })} /></label><label className="field"><span>Payment terms · days</span><input required type="number" min={0} max={365} value={form.dueDays} onChange={event => setForm({ ...form, dueDays: Number(event.target.value) })} /></label></div>
          <div className="form-grid two"><label className="field"><span>Invoice template</span><select value={form.templateId} onChange={event => setForm({ ...form, templateId: event.target.value })}><option value="">Use active default</option>{data.templates.map(template => <option key={template._id} value={template._id}>{template.name}{template.isDefault ? " · default" : ""}</option>)}</select></label><label className="field"><span>Customer reference · optional</span><input maxLength={80} placeholder="Contract or PO number" value={form.customerReference} onChange={event => setForm({ ...form, customerReference: event.target.value })} /></label></div>
          <label className="field"><span>Billing address · optional</span><textarea rows={2} maxLength={300} value={form.billingAddress} onChange={event => setForm({ ...form, billingAddress: event.target.value })} /></label>
          <div className="invoice-dimension-selection"><label className="field"><span>Management classification</span><select value={form.dimensionMode} onChange={event => setForm({ ...form, dimensionMode: event.target.value as DimensionMode })}><option value="CUSTOMER_DEFAULT">Use customer account default</option><option value="CUSTOM">Override for generated drafts</option><option value="NONE">Leave unassigned</option></select></label><p>This rule is resolved again for each draft so archived or invalid dimensions cannot silently enter accounting.</p>{form.dimensionMode === "CUSTOM" ? <div className="form-grid two"><label className="field"><span>Cost centre · optional</span><select value={form.costCentreId} onChange={event => setForm({ ...form, costCentreId: event.target.value })}><option value="">Not assigned</option>{data.dimensions.filter(item => item.type === "COST_CENTRE").map(item => <option key={item._id} value={item._id}>{item.code} · {item.name}</option>)}</select></label><label className="field"><span>Project · optional</span><select value={form.projectId} onChange={event => setForm({ ...form, projectId: event.target.value })}><option value="">Not assigned</option>{data.dimensions.filter(item => item.type === "PROJECT").map(item => <option key={item._id} value={item._id}>{item.code} · {item.name}</option>)}</select></label></div> : null}</div>
          <div className="invoice-draft-lines">{form.items.map((item, index) => <div className="invoice-draft-line" key={index}><label className="field invoice-line-description"><span>Item {index + 1} · description</span><input required minLength={2} maxLength={160} value={item.description} onChange={event => changeItem(index, { description: event.target.value })} /></label><label className="field"><span>Quantity</span><input required type="number" min="0.01" max="100000" step="0.01" value={item.quantity} onChange={event => changeItem(index, { quantity: Number(event.target.value) })} /></label><label className="field"><span>Unit price · {profile.currency}</span><input required type="number" min="0" max="100000000" step={10 ** -currencyFractionDigits(profile.currency)} value={item.unitPrice} onChange={event => changeItem(index, { unitPrice: Number(event.target.value) })} /></label><strong className="invoice-line-total">{money.format(roundCurrency(item.quantity * item.unitPrice, profile.currency))}</strong><button type="button" className="icon-button" aria-label={`Remove item ${index + 1}`} disabled={form.items.length === 1} onClick={() => setForm(current => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 size={16} /></button></div>)}<button type="button" className="button button-quiet" disabled={form.items.length >= 50} onClick={() => setForm(current => ({ ...current, items: [...current.items, { description: "", quantity: 1, unitPrice: 0 }] }))}><Plus size={15} />Add item</button></div>
          <label className="field"><span>Customer-facing notes · optional</span><textarea rows={3} maxLength={500} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
        </fieldset>
        <dl className="invoice-draft-totals"><div><dt>Current subtotal</dt><dd>{money.format(subtotal)}</dd></div><div><dt>{profile.taxName} · {totals.taxRate}%{totals.taxMode === "INCLUSIVE" ? " included" : " added"}</dt><dd>{money.format(totals.tax)}</dd></div><div><dt>Current draft estimate</dt><dd>{money.format(totals.total)}</dd></div></dl>
        <footer><button type="button" className="button button-secondary" disabled={busy || Boolean(uncertainPayload)} onClick={() => setCreateOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy || !dimensionValid}><CalendarClock size={16} />{busy ? "Saving…" : uncertainPayload ? "Retry same save" : "Activate schedule"}</button></footer>
      </form>
    </Modal>
  </div>;
}
