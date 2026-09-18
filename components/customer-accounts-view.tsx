"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { BadgeDollarSign, FileText, Printer, Search, ShieldAlert, SlidersHorizontal, UsersRound } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { currencyFractionDigits } from "@/lib/international";

export type CustomerAccount = {
  _id: string;
  memberNo: string;
  name: string;
  email: string;
  phone: string;
  creditLimit: number | null;
  creditTermsDays: number;
  creditHold: boolean;
  updatedAt: string;
  outstanding: number;
  overdue: number;
  openInvoices: number;
  availableCredit: number | null;
  lastInvoiceAt: string | null;
};

type AccountBundle = { currency: string; accounts: CustomerAccount[] };
type StatementEntry = {
  id: string; date: string; type: "INVOICE" | "PAYMENT"; invoiceNo: string;
  reference: string; dueDate: string; charge: number; payment: number; balance: number;
};
type Statement = {
  account: Pick<CustomerAccount, "_id" | "memberNo" | "name" | "email" | "phone" | "creditLimit" | "creditTermsDays" | "creditHold" | "updatedAt">;
  currency: string;
  generatedAt: string;
  summary: { invoiced: number; paid: number; outstanding: number; overdue: number };
  entries: StatementEntry[];
};

export function CustomerAccountsView({ canWrite }: { canWrite: boolean }) {
  const { profile } = useBusiness();
  const [data, setData] = useState<AccountBundle>({ currency: profile.currency, accounts: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<CustomerAccount | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const { notice, show } = useNotice();
  const money = useMemo(() => new Intl.NumberFormat(profile.locale, { style: "currency", currency: data.currency }), [data.currency, profile.locale]);
  const date = useMemo(() => new Intl.DateTimeFormat(profile.locale, { day: "2-digit", month: "short", year: "numeric", timeZone: profile.timeZone }), [profile.locale, profile.timeZone]);

  async function load() {
    setLoading(true);
    try { setData(await apiRequest<AccountBundle>("/api/customer-accounts")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load customer accounts.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function openStatement(account: CustomerAccount) {
    setStatementLoading(true);
    try { setStatement(await apiRequest<Statement>(`/api/customer-accounts?id=${account._id}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not prepare the customer statement.", "error"); }
    finally { setStatementLoading(false); }
  }

  async function saveControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || busy) return;
    const form = new FormData(event.currentTarget);
    const limitText = String(form.get("creditLimit") || "").trim();
    setBusy(true);
    try {
      await apiRequest("/api/customer-accounts", {
        method: "PATCH",
        body: JSON.stringify({
          id: editing._id,
          expectedUpdatedAt: editing.updatedAt,
          creditLimit: limitText === "" ? null : Number(limitText),
          creditTermsDays: Number(form.get("creditTermsDays")),
          creditHold: form.get("creditHold") === "on",
          reason: form.get("reason"),
        }),
      });
      show(`${editing.memberNo} credit controls updated.`);
      setEditing(null);
      await load();
    } catch (reason) { show(reason instanceof Error ? reason.message : "Could not update the customer account.", "error"); }
    finally { setBusy(false); }
  }

  const needle = search.trim().toLocaleLowerCase();
  const visible = data.accounts.filter(account => [account.memberNo, account.name, account.email, account.phone].join(" ").toLocaleLowerCase().includes(needle));
  const totalOutstanding = data.accounts.reduce((sum, account) => sum + account.outstanding, 0);
  const totalOverdue = data.accounts.reduce((sum, account) => sum + account.overdue, 0);
  const onHold = data.accounts.filter(account => account.creditHold).length;
  const accountStatus = (account: CustomerAccount) => account.creditHold ? "ON_HOLD" : account.creditLimit !== null && account.outstanding > account.creditLimit ? "OVER_LIMIT" : "ACTIVE";

  return <div className="page page-enter customer-account-page">
    <PageHeader eyebrow="ACCOUNTS RECEIVABLE" title="Customer accounts" description="Control account credit and prepare a traceable statement from issued invoices and received payments." />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row customer-account-stats">
      <article><BadgeDollarSign /><span>Outstanding</span><strong>{money.format(totalOutstanding)}</strong></article>
      <article className={totalOverdue > 0 ? "warn" : ""}><ShieldAlert /><span>Overdue</span><strong>{money.format(totalOverdue)}</strong></article>
      <article className={onHold ? "warn" : ""}><UsersRound /><span>Credit holds</span><strong>{onHold}</strong></article>
    </section>
    <section className="panel customer-credit-policy"><ShieldAlert /><div><strong>Credit is checked when an invoice is sent.</strong><p>Drafts do not consume credit. A direct full payment remains possible while a customer is on hold, and every control change is written to the audit trail.</p></div></section>
    <section className="panel resource-panel customer-account-panel">
      <div className="customer-account-toolbar"><label className="field"><span><Search size={14} />Search customer accounts</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Member number, name, email or phone" /></label><button className="button button-secondary" disabled={loading} onClick={load}>Refresh</button></div>
      {loading ? <LoadingPanel label="Preparing account balances…" /> : visible.length ? <div className="data-list customer-account-list">
        <div className="data-list-head"><span>Customer</span><span>Credit control</span><span>Outstanding</span><span>Overdue</span><span>Status</span><span>Actions</span></div>
        {visible.map(account => <div className="data-row" key={account._id}>
          <div><strong>{account.name}</strong><small>{account.memberNo} · {account.email || account.phone}</small></div>
          <div><strong>{account.creditLimit === null ? "No limit configured" : money.format(account.creditLimit)}</strong><small>{account.creditTermsDays} day terms{account.availableCredit === null ? "" : ` · ${money.format(account.availableCredit)} available`}</small></div>
          <div><strong>{money.format(account.outstanding)}</strong><small>{account.openInvoices} open invoice{account.openInvoices === 1 ? "" : "s"}</small></div>
          <div><strong>{money.format(account.overdue)}</strong><small>{account.lastInvoiceAt ? `Last invoice ${date.format(new Date(account.lastInvoiceAt))}` : "No issued invoices"}</small></div>
          <StatusPill value={accountStatus(account)} />
          <div className="row-actions"><button className="button button-quiet" disabled={statementLoading} onClick={() => void openStatement(account)}><FileText size={14} />Statement</button>{canWrite ? <button className="button button-secondary" onClick={() => setEditing(account)}><SlidersHorizontal size={14} />Controls</button> : null}</div>
        </div>)}
      </div> : <EmptyState title={data.accounts.length ? "No matching customer" : "No customer accounts"} detail={data.accounts.length ? "Change the search to find another account." : "Create a member first, then link that account while drafting an invoice."} />}
    </section>

    <Modal open={Boolean(editing)} onClose={() => { if (!busy) setEditing(null); }} title={`Credit controls · ${editing?.name || "customer"}`} kicker={editing?.memberNo}>
      {editing ? <form className="modal-form" onSubmit={saveControls}>
        <p className="form-hint">Leave the limit blank for no configured ceiling. Enter zero to prevent new account-credit invoices while still allowing immediate full payment.</p>
        <div className="form-grid two"><label className="field"><span>Credit limit · {data.currency}</span><input name="creditLimit" type="number" min="0" max="100000000" step={10 ** -currencyFractionDigits(data.currency)} defaultValue={editing.creditLimit ?? ""} placeholder="No configured limit" /></label><label className="field"><span>Default terms · days</span><input name="creditTermsDays" type="number" min="0" max="365" step="1" defaultValue={editing.creditTermsDays} required /></label></div>
        <label className="customer-hold-toggle"><input name="creditHold" type="checkbox" defaultChecked={editing.creditHold} /><span><strong>Place account on credit hold</strong><small>Blocks marking linked drafts as sent; it does not rewrite existing invoices.</small></span></label>
        <label className="field"><span>Reason for this control change</span><textarea name="reason" minLength={3} maxLength={300} rows={3} required placeholder="Approved limit, temporary hold, reviewed terms…" /></label>
        <footer><button type="button" className="button button-secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : "Save controls"}</button></footer>
      </form> : null}
    </Modal>

    <Modal open={Boolean(statement)} onClose={() => setStatement(null)} title={`Customer statement · ${statement?.account.name || ""}`} kicker={statement?.account.memberNo}>
      {statement ? <div className="customer-statement">
        <header><div><strong>{statement.account.name}</strong><span>{statement.account.email || statement.account.phone || "No contact saved"}</span></div><button className="button button-secondary customer-statement-print" onClick={() => window.print()}><Printer size={14} />Print</button></header>
        <section className="customer-statement-summary"><span><small>Invoiced</small><strong>{money.format(statement.summary.invoiced)}</strong></span><span><small>Paid</small><strong>{money.format(statement.summary.paid)}</strong></span><span><small>Outstanding</small><strong>{money.format(statement.summary.outstanding)}</strong></span><span className={statement.summary.overdue > 0 ? "warn" : ""}><small>Overdue</small><strong>{money.format(statement.summary.overdue)}</strong></span></section>
        {statement.entries.length ? <div className="report-table-wrap"><table className="report-table customer-statement-table"><thead><tr><th>Date</th><th>Type</th><th>Invoice</th><th>Reference</th><th>Due</th><th className="number">Charge</th><th className="number">Payment</th><th className="number">Balance</th></tr></thead><tbody>{statement.entries.map(entry => <tr key={entry.id}><td>{date.format(new Date(entry.date))}</td><td>{entry.type}</td><td>{entry.invoiceNo}</td><td>{entry.reference || "—"}</td><td>{entry.type === "INVOICE" ? date.format(new Date(entry.dueDate)) : "—"}</td><td className="number">{entry.charge ? money.format(entry.charge) : "—"}</td><td className="number">{entry.payment ? money.format(entry.payment) : "—"}</td><td className="number"><b>{money.format(entry.balance)}</b></td></tr>)}</tbody></table></div> : <EmptyState title="No issued invoices" detail="Draft and void invoices do not appear on a customer statement." />}
        <footer>Generated {date.format(new Date(statement.generatedAt))} · {statement.currency} · Management statement, not proof of payment.</footer>
      </div> : null}
    </Modal>
  </div>;
}
