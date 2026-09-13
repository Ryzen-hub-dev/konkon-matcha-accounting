"use client";
import { useState } from "react";
import { Globe2, Download } from "lucide-react";
import { COUNTRY_PROFILES, countryProfile } from "@/lib/international";
import { countryReportPack, countryReportCsv, countryWorksheet, type StatementExport } from "@/lib/country-reporting";
import { downloadReceiptFile } from "@/lib/receipt-export";

export function CountryReportPanel({ data, countryCode, company }: { data: StatementExport; countryCode: string; company: string }) {
  const [country, setCountry] = useState(countryCode);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const pack = countryReportPack(country);
  const money = new Intl.NumberFormat("en", { style: "currency", currency: data.period.currency });
  let derived: ReturnType<typeof countryWorksheet>["rows"] = [];
  try { derived = countryWorksheet(country, values).rows.filter(row => row.origin === "DERIVED_FROM_USER_ENTRIES"); } catch { /* field errors are shown by the download validation */ }
  function download(format: "CSV" | "JSON") {
    try {
      const worksheet = countryWorksheet(country, values);
      const { period, profitAndLoss, balanceSheet, cashFlow, trialBalance, tax, integrity } = data;
      const content = format === "CSV" ? countryReportCsv(data, country, values, company) : JSON.stringify({ schema: "konkon.country-report.v1", company, generatedAt: new Date().toISOString(), worksheet, statements: { period, profitAndLoss, balanceSheet, cashFlow, trialBalance, tax, integrity }, basis: "Posted journals only. Sent unpaid invoices are not accrued by the current invoice workflow. Book currency is unchanged; national filing validation has not run." }, null, 2);
      downloadReceiptFile(content, format === "CSV" ? "text/csv;charset=utf-8" : "application/json", `${country}-accounts-${data.period.from}-${data.period.to}.${format.toLowerCase()}`); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Check the working figures."); }
  }
  return <section className="country-report-panel statement-sheet">
    <header><span><Globe2 size={18} /> COUNTRY REPORT DESK</span><h2>Books without borders.</h2><p>Download profit & loss, balance sheet, cash flow, trial balance and a country working paper together.</p></header>
    <div className="country-report-controls"><label className="field"><span>Reporting country / region</span><select value={country} onChange={event => { setCountry(event.target.value); setValues({}); setError(""); }}>{COUNTRY_PROFILES.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label><div><strong>{data.period.currency} · {data.period.from} → {data.period.to}</strong><p>Changing the report country does not convert amounts or change your workspace country.</p></div></div>
    <aside className="document-readiness"><strong>Working papers, not filed returns</strong><p>{pack.note}</p><p>These statements include posted journals only. Sent unpaid invoices need accountant-approved accrual journals for accrual reporting. Local accounting disclosures and adjustments are not generated automatically.</p>{countryProfile(country).currency !== data.period.currency ? <p>Book currency differs from this country’s usual currency. Arrange any required reporting-currency conversion with your accountant; this export does not convert it.</p> : null}{!data.integrity.balanced ? <p role="alert">The ledger is not balanced. Resolve the close warnings before relying on this report.</p> : null}</aside>
    <h3>{pack.name}</h3><p>Enter accountant-reviewed amounts below. Empty means unreviewed, not zero. No tax rate or input-credit eligibility is assumed.</p>
    <div className="report-summary-strip"><div><span>Output tax ledger, net</span><strong>{money.format(data.tax.outputTaxCharged - data.tax.outputTaxAdjustments)}</strong></div><div><span>Input tax ledger, net</span><strong>{money.format(data.tax.inputTaxRecoverable - data.tax.inputTaxAdjustments)}</strong></div><div><span>Evidence only</span><small>Reconcile these ledger totals; do not copy them blindly into return boxes.</small></div></div>
    <div className="country-tax-fields">{pack.fields.map(field => <label className="field" key={field.code}><span>{field.code} · {field.label}</span><input type="number" step="any" value={values[field.code] ?? ""} placeholder="Not reviewed" onChange={event => setValues(current => ({ ...current, [field.code]: event.target.value }))} /></label>)}</div>
    {derived.length ? <div className="report-summary-strip">{derived.map(row => <div key={row.code}><span>{row.code} · {row.label}</span><strong>{row.amount === null ? "Awaiting reviewed inputs" : money.format(row.amount)}</strong></div>)}</div> : null}
    {pack.source ? <p><a href={pack.source} target="_blank" rel="noreferrer">Read {pack.authority} guidance ↗</a></p> : null}
    <footer className="document-export-actions no-print"><button className="button button-primary" onClick={() => download("CSV")}><Download size={16} />Download country report CSV</button><button className="button button-secondary" onClick={() => download("JSON")}>Download accounting JSON</button></footer>{error ? <p role="alert" className="card-error">{error}</p> : null}
  </section>;
}
