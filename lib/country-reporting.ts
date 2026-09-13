import { countryCodeSchema, countryProfile } from "./international";
import { csvCell } from "./receipt-export";

type Field = { code: string; label: string };
export type CountryReportPack = { name: string; authority: string; source: string; fields: Field[]; note: string };
const fields = (entries: Array<[string, string]>): Field[] => entries.map(([code, label]) => ({ code, label }));
const PACKS: Record<string, CountryReportPack> = {
  SG: { name: "GST F5 preparation", authority: "IRAS", source: "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst/completing-gst-returns", note: "Core F5 working figures only. Other boxes, reverse charge, imports and scheme-specific disclosures require review.", fields: fields([["1", "Standard-rated supplies"], ["2", "Zero-rated supplies"], ["3", "Exempt supplies"], ["5", "Taxable purchases"], ["6", "Output tax due"], ["7", "Input tax and refunds claimed"]]) },
  MY: { name: "SST preparation", authority: "Royal Malaysian Customs", source: "https://mysst.customs.gov.my/sst-forms/", note: "Prepare sales tax and service tax separately. SST is not a VAT input-credit system. Timing, exemptions and rate breakdowns must be confirmed before SST-02 filing.", fields: fields([["SALES_VALUE", "Taxable sales value"], ["SALES_TAX", "Sales tax payable"], ["SERVICE_VALUE", "Taxable service value"], ["SERVICE_TAX", "Service tax payable"], ["SALES_ADJUSTMENT", "Sales tax adjustment (signed)"], ["SERVICE_ADJUSTMENT", "Service tax adjustment (signed)"]]) },
  AU: { name: "BAS GST preparation", authority: "Australian Taxation Office", source: "https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas", note: "GST working figures only, not a complete BAS. Confirm cash/non-cash method, GST-free sales and credit eligibility. PAYG and other BAS obligations are separate.", fields: fields([["G1", "Total sales including GST"], ["1A", "GST on sales"], ["1B", "GST on purchases"]]) },
  GB: { name: "VAT return preparation", authority: "HMRC", source: "https://www.gov.uk/guidance/how-to-fill-in-and-submit-your-vat-return-vat-notice-70012", note: "Review special schemes and Northern Ireland rules. This is not an MTD submission and does not establish a compliant digital-link chain.", fields: fields([["1", "VAT due on sales and outputs"], ["2", "VAT due on relevant EU acquisitions"], ["4", "VAT reclaimed on purchases"], ["6", "Sales excluding VAT"], ["7", "Purchases excluding VAT"], ["8", "Relevant EU dispatches excluding VAT"], ["9", "Relevant EU acquisitions excluding VAT"]]) },
};
export function countryReportPack(code: string): CountryReportPack {
  countryCodeSchema.parse(code);
  return PACKS[code] || { name: "Country accounting working paper", authority: "Local tax authority / accountant", source: "", fields: fields([["TAXABLE_SALES", "Taxable sales — accountant classified"], ["OUTPUT_TAX", "Output tax — accountant confirmed"], ["INPUT_CREDIT", "Eligible input credits, if applicable"], ["ADJUSTMENTS", "Tax adjustments (signed)"]]), note: "No national tax-return adapter is installed for this country. The financial statements and working paper are available; local tax forms, accounting standards and electronic filing still require a country-specific review." };
}
export function countryWorksheet(code: string, values: Record<string, string>) {
  const pack = countryReportPack(code);
  const rows = pack.fields.map(field => {
    const raw = values[field.code]?.trim() || "";
    if (raw && (!/^-?\d{1,14}(\.\d{1,6})?$/.test(raw) || !Number.isFinite(Number(raw)))) throw new Error(`Check ${field.label}.`);
    return { ...field, amount: raw === "" ? null : Number(raw), origin: raw === "" ? "NOT_REVIEWED" : "USER_ENTERED" };
  });
  const amount = (key: string) => rows.find(row => row.code === key)?.amount ?? null;
  const derive = (key: string, label: string, keys: string[], compute: (n: number[]) => number) => {
    const numbers = keys.map(amount);
    rows.push({ code: key, label, amount: numbers.some(n => n === null) ? null : Math.round(compute(numbers as number[]) * 1e6) / 1e6, origin: "DERIVED_FROM_USER_ENTRIES" });
  };
  if (code === "SG") { derive("4", "Total supplies", ["1", "2", "3"], n => n.reduce((s, v) => s + v, 0)); derive("8", "Net GST payable / refundable", ["6", "7"], n => n[0] - n[1]); }
  if (code === "GB") { derive("3", "Total VAT due", ["1", "2"], n => n[0] + n[1]); derive("5", "Net VAT (absolute); verify payable/refundable direction", ["3", "4"], n => Math.abs(n[0] - n[1])); }
  return { country: countryProfile(code).name, countryCode: code, pack: pack.name, adapterVersion: "2026-09-13-preparation-v1", status: "WORKING_PAPER_NOT_FILED", rows, note: pack.note, source: pack.source };
}

export type StatementExport = {
  period: { from: string; to: string; timeZone: string; currency: string };
  profitAndLoss: { revenue: Array<{ code: string; name: string; amount: number }>; expenses: Array<{ code: string; name: string; amount: number }>; netProfit: number };
  balanceSheet: { assets: Array<{ code: string; name: string; amount: number }>; liabilities: Array<{ code: string; name: string; amount: number }>; equity: Array<{ code: string; name: string; amount: number }> };
  cashFlow: { operating: Array<{ code: string; name: string; amount: number }>; investing: Array<{ code: string; name: string; amount: number }>; financing: Array<{ code: string; name: string; amount: number }>; unclassified: Array<{ code: string; name: string; amount: number }>; openingCash: number; closingCash: number };
  trialBalance: { rows: Array<{ code: string; name: string; openingDebit: number; openingCredit: number; periodDebit: number; periodCredit: number; closingDebit: number; closingCredit: number }> };
  tax: { outputTaxCharged: number; outputTaxAdjustments: number; inputTaxRecoverable: number; inputTaxAdjustments: number; netMovement: number };
  integrity: { balanced: boolean };
};
export function countryReportCsv(data: StatementExport, code: string, values: Record<string, string>, company: string) {
  const worksheet = countryWorksheet(code, values);
  const rows: unknown[][] = [["Company", company], ["Country", worksheet.country], ["Status", worksheet.status], ["Period", data.period.from, data.period.to], ["Book currency (no conversion)", data.period.currency], ["Book time zone", data.period.timeZone], ["Ledger balanced", data.integrity.balanced], ["Basis", "Posted journals only; sent unpaid invoices are not accrued by the current invoice workflow."], ["Review", worksheet.note], [], ["Statement", "Section", "Code", "Account", "Amount"]];
  for (const [statement, sections] of [["Profit and loss", { Revenue: data.profitAndLoss.revenue, Expenses: data.profitAndLoss.expenses }], ["Balance sheet", data.balanceSheet], ["Cash flow", { Operating: data.cashFlow.operating, Investing: data.cashFlow.investing, Financing: data.cashFlow.financing, Unclassified: data.cashFlow.unclassified }]] as const) {
    for (const [section, entries] of Object.entries(sections)) if (Array.isArray(entries)) for (const row of entries) rows.push([statement, section, row.code, row.name, row.amount]);
  }
  rows.push(["Profit and loss", "Net profit", "", "", data.profitAndLoss.netProfit], ["Cash flow", "Opening cash", "", "", data.cashFlow.openingCash], ["Cash flow", "Closing cash", "", "", data.cashFlow.closingCash], [], ["Trial balance", "Account", "Opening debit", "Opening credit", "Period debit", "Period credit", "Closing debit", "Closing credit"]);
  for (const row of data.trialBalance.rows) rows.push([row.code, row.name, row.openingDebit, row.openingCredit, row.periodDebit, row.periodCredit, row.closingDebit, row.closingCredit]);
  rows.push([], ["Tax ledger evidence (NOT return box values)", "Amount"]);
  for (const [key, value] of Object.entries(data.tax)) rows.push([key, value]);
  rows.push([], [worksheet.pack, "Field", "Amount (blank = not reviewed)", "Origin"]);
  for (const row of worksheet.rows) rows.push([row.code, row.label, row.amount, row.origin]);
  rows.push(["Official guidance", worksheet.source]);
  return "\uFEFF" + rows.map(row => row.map(value => typeof value === "number" ? String(value) : csvCell(value)).join(",")).join("\r\n");
}
