"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Banknote, CheckCircle2, Download, Eye, FileSpreadsheet, Link2, Search, ShieldCheck, Unlink, XCircle } from "lucide-react";
import { useBusiness } from "@/components/business-context";
import { AddButton, apiRequest, EmptyState, LoadingPanel, Modal, Notice, PageHeader, StatusPill, useNotice } from "@/components/ui";
import { assertStatementArithmetic, parseBankStatementCsv, ParsedBankRow, statementMovement } from "@/lib/bank-reconciliation";
import { dateKeyInTimeZone, formatCalendarDate, shiftDateKey } from "@/lib/dates";
import { currencyFractionDigits, currencyMinorUnits } from "@/lib/international";

type Account = { _id: string; code: string; name: string };
type Reconciliation = {
  _id: string; reconciliationNo: string; accountCode: string; accountName: string; currency: string;
  statementStartDate: string; statementDate: string; openingBalance: number; closingBalance: number;
  statementMovement: number; rowCount: number; matchedCount: number; status: string; updatedAt: string;
  ledgerOpeningBalance?: number; ledgerClosingBalance?: number; adjustedStatementBalance?: number; difference?: number;
  openingDifference?: number; unmatchedCurrentNet?: number; matchedPriorNet?: number; reviewNote?: string;
  unclearedLedgerLines?: LedgerCandidate[]; matchedPriorLines?: LedgerCandidate[];
};
type StatementRow = {
  rowId: string; date: string; description: string; reference: string; amount: number; status: string;
  matchedJournalEntryId?: string; matchedLineIndex?: number; matchedEntryNo?: string; matchedBusinessDate?: string; matchedMemo?: string;
};
type LedgerCandidate = { key?: string; journalEntryId: string; lineIndex: number; entryNo: string; businessDate: string; memo: string; reference: string; amount: number };
type ReconciliationDetail = Reconciliation & { rows: StatementRow[]; candidates: LedgerCandidate[]; suggestions: Record<string, string> };
type ListData = { reconciliations: Reconciliation[]; accounts: Account[] };

export function BankReconciliationView({ canWrite }: { canWrite: boolean }) {
  const { profile } = useBusiness();
  const [data, setData] = useState<ListData>({ reconciliations: [], accounts: [] });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [importing, setImporting] = useState(false);
  const [detail, setDetail] = useState<ReconciliationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const { notice, show } = useNotice();

  async function load() {
    setLoading(true);
    try { setData(await apiRequest<ListData>("/api/bank-reconciliations")); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not load bank reconciliations.", "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function openDetail(id: string) {
    setDetailLoading(true);
    try { setDetail(await apiRequest<ReconciliationDetail>(`/api/bank-reconciliations?id=${encodeURIComponent(id)}`)); }
    catch (reason) { show(reason instanceof Error ? reason.message : "Could not open the reconciliation.", "error"); }
    finally { setDetailLoading(false); }
  }

  const needle = search.trim().toLocaleLowerCase();
  const visible = data.reconciliations.filter(item => (filter === "ALL" || item.status === filter)
    && [item.reconciliationNo, item.accountCode, item.accountName].join(" ").toLocaleLowerCase().includes(needle));
  const drafts = data.reconciliations.filter(item => item.status === "DRAFT");
  const completed = data.reconciliations.filter(item => item.status === "COMPLETED");
  const money = new Intl.NumberFormat(profile.locale, { style: "currency", currency: profile.currency });

  return <div className="page page-enter bank-reconciliation-page">
    <PageHeader eyebrow="CASH CONTROL" title="Bank reconciliation" description="Import a local CSV statement, match it to posted ledger lines and lock a reviewed reconciliation with uncleared-item evidence." action={canWrite ? <AddButton onClick={() => setImporting(true)}>Import statement</AddButton> : undefined} />
    {notice ? <Notice {...notice} /> : null}
    <section className="mini-stat-row bank-reconciliation-stats"><article><FileSpreadsheet /><span>Statements</span><strong>{data.reconciliations.length}</strong></article><article><ArrowLeftRight /><span>Open reviews</span><strong>{drafts.length}</strong></article><article><CheckCircle2 /><span>Completed</span><strong>{completed.length}</strong></article></section>
    <section className="panel bank-reconciliation-policy"><ShieldCheck /><div><strong>CSV import stays inside this workspace and is not a live bank connection.</strong><p>Automatic matches are suggestions only. Staff must confirm every line; completion requires balanced statement arithmetic and a zero reconciliation difference.</p></div></section>
    <section className="panel resource-panel bank-reconciliation-register">
      <div className="quotation-toolbar"><label className="field"><span><Search size={14} />Search reconciliations</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Number or bank account" /></label><label className="field"><span>Status</span><select value={filter} onChange={event => setFilter(event.target.value)}>{["ALL", "DRAFT", "COMPLETED", "VOID"].map(value => <option key={value} value={value}>{value === "ALL" ? "All statuses" : value}</option>)}</select></label><button className="button button-secondary" disabled={loading} onClick={load}>Refresh</button></div>
      {loading ? <LoadingPanel label="Preparing reconciliations…" /> : visible.length ? <div className="data-list bank-reconciliation-list"><div className="data-list-head"><span>Reconciliation</span><span>Account</span><span>Statement period</span><span>Closing balance</span><span>Matched</span><span>Status</span><span>Actions</span></div>{visible.map(item => <div className="data-row" key={item._id}><div><strong>{item.reconciliationNo}</strong><small>{item.currency}</small></div><div><strong>{item.accountCode} · {item.accountName}</strong><small>{item.status === "COMPLETED" ? "Locked working paper" : "Review in progress"}</small></div><div><strong>{formatCalendarDate(item.statementStartDate, profile.locale)} – {formatCalendarDate(item.statementDate, profile.locale)}</strong><small>Imported statement range</small></div><strong>{money.format(item.closingBalance)}</strong><div><strong>{item.matchedCount}/{item.rowCount}</strong><small>{item.rowCount ? Math.round(item.matchedCount / item.rowCount * 100) : 0}%</small></div><StatusPill value={item.status} /><div className="row-actions"><button className="button button-secondary" onClick={() => void openDetail(item._id)}><Eye size={14} />Review</button></div></div>)}</div> : <EmptyState title="No bank reconciliations" detail="Import a CSV statement to begin matching bank movements against posted ledger entries." action={canWrite ? <AddButton onClick={() => setImporting(true)}>Import statement</AddButton> : undefined} />}
    </section>

    {importing ? <StatementImport accounts={data.accounts} onClose={() => setImporting(false)} onCreated={async item => { setImporting(false); show(`${item.reconciliationNo} imported. Review suggested matches before completing.`); await load(); await openDetail(item._id); }} /> : null}
    <Modal open={detailLoading && !detail} onClose={() => setDetailLoading(false)} title="Loading reconciliation" kicker="BANK CONTROL"><LoadingPanel label="Finding ledger candidates…" /></Modal>
    {detail ? <ReconciliationDesk key={detail.updatedAt} detail={detail} canWrite={canWrite} onClose={() => setDetail(null)} onChanged={async message => { show(message); await load(); await openDetail(detail._id); }} /> : null}
  </div>;
}

function StatementImport({ accounts, onClose, onCreated }: { accounts: Account[]; onClose: () => void; onCreated: (item: Reconciliation) => void }) {
  const { profile } = useBusiness();
  const today = dateKeyInTimeZone(new Date(), profile.timeZone);
  const [accountCode, setAccountCode] = useState(accounts[0]?.code || "");
  const [startDate, setStartDate] = useState(shiftDateKey(today, -30));
  const [statementDate, setStatementDate] = useState(today);
  const [openingBalance, setOpeningBalance] = useState("");
  const [closingBalance, setClosingBalance] = useState("");
  const [csv, setCsv] = useState("date,description,reference,amount\n");
  const [rows, setRows] = useState<ParsedBankRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const money = new Intl.NumberFormat(profile.locale, { style: "currency", currency: profile.currency });

  function parse(text = csv) {
    try { const parsed = parseBankStatementCsv(text); setRows(parsed); setError(""); }
    catch (reason) { setRows([]); setError(reason instanceof Error ? reason.message : "Could not parse the CSV."); }
  }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 1_000_000) { setError("The CSV is too large. Import at most 500 rows at a time."); return; }
    try { const text = await file.text(); setCsv(text); parse(text); }
    catch { setError("Could not read that CSV file."); }
  }
  function downloadTemplate() {
    const blob = new Blob(["date,description,reference,amount\n2026-09-01,Customer transfer,TXN-001,125.00\n2026-09-02,Bank charge,FEE-001,-2.00\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "bank-statement-template.csv"; anchor.click(); URL.revokeObjectURL(url);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setError("");
    let parsed = rows;
    try {
      if (!parsed.length) parsed = parseBankStatementCsv(csv);
      assertStatementArithmetic(Number(openingBalance), Number(closingBalance), parsed, profile.currency);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Check the statement."); return; }
    setBusy(true);
    try {
      const item = await apiRequest<Reconciliation>("/api/bank-reconciliations", { method: "POST", body: JSON.stringify({ accountCode, statementStartDate: startDate, statementDate, openingBalance, closingBalance, rows: parsed, clientRequestId: requestId }) });
      onCreated(item);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not import the statement."); }
    finally { setBusy(false); }
  }
  const movement = rows.length ? statementMovement(rows, profile.currency) : 0;
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Import bank statement" kicker="CSV · LOCAL FILE"><form className="modal-form wide-form bank-import-form" onSubmit={submit}>{error ? <div className="invoice-form-error" role="alert">{error}</div> : null}<fieldset disabled={busy}><div className="form-grid three"><label className="field"><span>Bank ledger account</span><select value={accountCode} onChange={event => setAccountCode(event.target.value)} required><option value="">Choose account</option>{accounts.map(account => <option key={account._id} value={account.code}>{account.code} · {account.name}</option>)}</select></label><label className="field"><span>Statement start</span><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} required /></label><label className="field"><span>Statement closing date</span><input type="date" value={statementDate} onChange={event => setStatementDate(event.target.value)} required /></label></div><div className="form-grid two"><label className="field"><span>Opening statement balance · {profile.currency}</span><input type="number" step={10 ** -currencyFractionDigits(profile.currency)} value={openingBalance} onChange={event => setOpeningBalance(event.target.value)} required /></label><label className="field"><span>Closing statement balance · {profile.currency}</span><input type="number" step={10 ** -currencyFractionDigits(profile.currency)} value={closingBalance} onChange={event => setClosingBalance(event.target.value)} required /></label></div><section className="bank-csv-tools"><div><label className="button button-secondary"><FileSpreadsheet size={15} />Choose CSV<input type="file" accept=".csv,text/csv" onChange={chooseFile} hidden /></label><button type="button" className="button button-quiet" onClick={downloadTemplate}><Download size={15} />Template</button></div><p>Required: <b>date</b> (YYYY-MM-DD), <b>description</b>, optional <b>reference</b>, and signed <b>amount</b>. Deposits are positive; payments and fees are negative. Debit/credit columns are also accepted.</p></section><label className="field"><span>CSV preview or paste</span><textarea value={csv} onChange={event => { setCsv(event.target.value); setRows([]); }} rows={7} spellCheck={false} /></label><button type="button" className="button button-secondary" onClick={() => parse()}>Validate CSV</button>{rows.length ? <div className="bank-import-summary"><span><small>Rows</small><strong>{rows.length}</strong></span><span><small>Statement movement</small><strong>{money.format(movement)}</strong></span><span><small>Expected closing</small><strong>{money.format(Number(openingBalance || 0) + movement)}</strong></span></div> : null}</fieldset><footer><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || !accountCode || !rows.length}>{busy ? "Importing…" : "Create reconciliation"}</button></footer></form></Modal>;
}

function ReconciliationDesk({ detail, canWrite, onClose, onChanged }: { detail: ReconciliationDetail; canWrite: boolean; onClose: () => void; onChanged: (message: string) => void | Promise<void> }) {
  const { profile } = useBusiness();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>(() => ({ ...detail.suggestions }));
  const [note, setNote] = useState("");
  const money = new Intl.NumberFormat(profile.locale, { style: "currency", currency: detail.currency });
  const candidatesByKey = useMemo(() => new Map(detail.candidates.map(candidate => [candidate.key!, candidate])), [detail.candidates]);
  async function act(payload: Record<string, unknown>, message: string) {
    if (busy) return; setError(""); setBusy(String(payload.action));
    try { await apiRequest("/api/bank-reconciliations", { method: "PATCH", body: JSON.stringify({ id: detail._id, expectedUpdatedAt: detail.updatedAt, ...payload }) }); await onChanged(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update the reconciliation."); }
    finally { setBusy(""); }
  }
  async function match(row: StatementRow) {
    const candidate = candidatesByKey.get(selected[row.rowId] || ""); if (!candidate) return;
    await act({ action: "MATCH", rowId: row.rowId, journalEntryId: candidate.journalEntryId, lineIndex: candidate.lineIndex }, `${row.description} matched to ${candidate.entryNo}.`);
  }
  const completionReady = detail.status === "DRAFT" && detail.matchedCount === detail.rowCount && note.trim().length >= 3;
  return <Modal open onClose={onClose} title={`Bank reconciliation ${detail.reconciliationNo}`} kicker={`${detail.accountCode} · ${detail.status}`}>
    <div className="bank-reconciliation-desk">
      {error ? <div className="invoice-form-error" role="alert">{error}</div> : null}
      <header className="bank-reconciliation-summary"><span><small>Statement period</small><strong>{formatCalendarDate(detail.statementStartDate, profile.locale)} – {formatCalendarDate(detail.statementDate, profile.locale)}</strong></span><span><small>Opening balance</small><strong>{money.format(detail.openingBalance)}</strong></span><span><small>Movement</small><strong>{money.format(detail.statementMovement)}</strong></span><span><small>Closing balance</small><strong>{money.format(detail.closingBalance)}</strong></span><span><small>Matched</small><strong>{detail.matchedCount}/{detail.rowCount}</strong></span></header>
      {detail.status === "DRAFT" ? <p className="bank-match-help"><Link2 size={16} />Suggested matches use exact amount and same/near dates. They remain unconfirmed until you press Match.</p> : null}
      <div className="bank-match-table"><div className="bank-match-head"><span>Bank statement</span><span>Amount</span><span>Ledger match</span><span>Action</span></div>{detail.rows.map(row => {
    const amountCandidates = detail.candidates.filter(candidate => currencyMinorUnits(candidate.amount, detail.currency) === currencyMinorUnits(row.amount, detail.currency));
    return <div className={`bank-match-row ${row.matchedJournalEntryId ? "is-matched" : ""}`} key={row.rowId}><div><strong>{row.description}</strong><small>{row.date}{row.reference ? ` · ${row.reference}` : ""}</small></div><strong className={row.amount < 0 ? "negative" : "positive"}>{money.format(row.amount)}</strong><div>{row.matchedJournalEntryId ? <><strong>{row.matchedEntryNo}</strong><small>{row.matchedBusinessDate} · {row.matchedMemo}</small></> : <select value={selected[row.rowId] || ""} onChange={event => setSelected(current => ({ ...current, [row.rowId]: event.target.value }))} disabled={!canWrite || detail.status !== "DRAFT"}><option value="">{amountCandidates.length ? "Choose ledger transaction" : "No amount match"}</option>{amountCandidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.entryNo} · {candidate.businessDate} · {candidate.memo}</option>)}</select>}</div><div>{row.matchedJournalEntryId ? <button className="button button-quiet" disabled={!canWrite || Boolean(busy) || detail.status !== "DRAFT"} onClick={() => void act({ action: "UNMATCH", rowId: row.rowId }, `${row.description} unmatched.`)}><Unlink size={14} />Unmatch</button> : <button className="button button-secondary" disabled={!canWrite || Boolean(busy) || detail.status !== "DRAFT" || !selected[row.rowId]} onClick={() => void match(row)}><Link2 size={14} />Match</button>}</div></div>;
  })}</div>{detail.status === "COMPLETED" ? <CompletedReconciliation detail={detail} /> : null}{detail.status === "DRAFT" && canWrite ? <section className="bank-reconciliation-actions"><label className="field"><span>Reviewer note or void reason</span><textarea value={note} onChange={event => setNote(event.target.value)} minLength={3} maxLength={300} rows={2} placeholder="Who reviewed this statement and what was checked?" /></label><div><button className="button button-quiet" disabled={Boolean(busy) || note.trim().length < 3} onClick={() => void act({ action: "VOID", note }, "Reconciliation voided; ledger matches were released.")}><XCircle size={15} />Void draft</button><button className="button button-primary" disabled={!completionReady || Boolean(busy)} onClick={() => void act({ action: "COMPLETE", note }, "Reconciliation completed and locked.")}><CheckCircle2 size={15} />Complete & lock</button></div></section> : null}<footer><button className="button button-secondary" onClick={onClose}>Close</button></footer></div></Modal>;
}

function CompletedReconciliation({ detail }: { detail: ReconciliationDetail }) {
  const { profile } = useBusiness();
  const money = new Intl.NumberFormat(profile.locale, { style: "currency", currency: detail.currency });
  return <section className="bank-completed-report"><header><ShieldCheck /><div><strong>Completed reconciliation</strong><span>{detail.reviewNote}</span></div></header><dl><div><dt>Ledger opening</dt><dd>{money.format(detail.ledgerOpeningBalance || 0)}</dd></div><div><dt>Opening difference / prior uncleared</dt><dd>{money.format(detail.openingDifference || 0)}</dd></div><div><dt>Current uncleared net</dt><dd>{money.format(detail.unmatchedCurrentNet || 0)}</dd></div><div><dt>Prior items cleared</dt><dd>{money.format(detail.matchedPriorNet || 0)}</dd></div><div><dt>Adjusted statement</dt><dd>{money.format(detail.adjustedStatementBalance || 0)}</dd></div><div><dt>Ledger closing</dt><dd>{money.format(detail.ledgerClosingBalance || 0)}</dd></div><div className="is-zero"><dt>Difference</dt><dd>{money.format(detail.difference || 0)}</dd></div></dl>{detail.unclearedLedgerLines?.length ? <div><h3>Current-period uncleared ledger items</h3>{detail.unclearedLedgerLines.map(line => <p key={`${line.journalEntryId}:${line.lineIndex}`}><span>{line.entryNo} · {line.businessDate} · {line.memo}</span><strong>{money.format(line.amount)}</strong></p>)}</div> : <p className="bank-all-cleared">All current-period ledger items cleared by the statement date.</p>}</section>;
}
