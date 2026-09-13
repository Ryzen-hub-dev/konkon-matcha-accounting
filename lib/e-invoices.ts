import { z } from "zod";
import { countryCodeSchema, currencyCodeSchema, currencyFractionDigits, currencyMinorUnits, roundCurrency } from "./international";
import { dateKeyInTimeZone } from "./dates";

const text = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value), "Remove unsupported control characters.");
export const eInvoicePartySchema = z.object({
  name: text(120).min(2), countryCode: countryCodeSchema, registrationNo: text(80).min(1), taxId: text(80).default(""),
  address: text(300).min(3), city: text(80).min(1), postalCode: text(20).default(""), stateCode: text(30).default(""),
  email: z.union([z.email(), z.literal("")]).default(""), phone: text(40).default(""),
});
export const eInvoiceInputSchema = z.object({
  sourceType: z.enum(["INVOICE", "RECEIPT"]), sourceId: z.string().regex(/^[a-f\d]{24}$/i),
  clientRequestId: z.string().uuid(), format: z.enum(["UBL_XML", "ACCOUNTING_JSON", "MYINVOIS_JSON"]),
  seller: eInvoicePartySchema, buyer: eInvoicePartySchema,
  taxCategory: z.enum(["S", "Z", "E", "O"]), taxReason: text(200).default(""),
  malaysia: z.object({ msic: z.string().regex(/^\d{5}$/), activity: text(160).min(2), classification: z.string().regex(/^\d{3}$/), taxType: z.enum(["01", "02", "06", "E"]), sellerSst: text(80).min(1), buyerSst: text(80).min(1) }).optional(),
  confirmed: z.literal(true),
});
export type EInvoiceInput = z.infer<typeof eInvoiceInputSchema>;
export class EInvoiceError extends Error { constructor(message: string, readonly status = 422) { super(message); } }

const sourceSchema = z.object({
  invoiceNo: text(80).optional(), receiptNo: text(80).optional(), status: z.string(),
  createdAt: z.coerce.date(), dueDate: z.coerce.date().optional(),
  businessSnapshot: z.object({ currency: currencyCodeSchema, countryCode: countryCodeSchema, timeZone: z.string() }),
  subtotal: z.number().nonnegative().finite(), discount: z.number().nonnegative().finite().default(0), tax: z.number().nonnegative().finite(), netSales: z.number().nonnegative().finite(), total: z.number().nonnegative().finite(), taxRate: z.number().min(0).max(100),
  paidAmount: z.number().nonnegative().default(0), refundedAmount: z.number().nonnegative().default(0),
  items: z.array(z.object({ description: text(200).optional(), name: text(200).optional(), quantity: z.number().positive().max(100000), lineTotal: z.number().nonnegative().finite() })).min(1).max(200),
});

// Largest-remainder allocation in integer minor units. No floating-point total drift.
export function allocateInvoiceAmount(total: number, weights: number[]) {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some(w => !Number.isSafeInteger(w) || w < 0) || !weights.length) throw new EInvoiceError("Invoice amounts exceed the safe accounting range.");
  const sum = weights.reduce((s, w) => s + BigInt(w), BigInt(0));
  if (!sum) { if (total !== 0) throw new EInvoiceError("Line totals cannot be reconciled."); return weights.map(() => 0); }
  const parts = weights.map((w, index) => ({ index, value: Number(BigInt(total) * BigInt(w) / sum), remainder: BigInt(total) * BigInt(w) % sum }));
  const left = total - parts.reduce((s, part) => s + part.value, 0);
  const priority = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; i < left; i++) priority[i].value++;
  return parts.map(part => part.value);
}

export function prepareEInvoice(raw: unknown, input: EInvoiceInput, generatedAt = new Date()) {
  const parsed = sourceSchema.safeParse(raw);
  if (!parsed.success) throw new EInvoiceError("This historical document lacks valid currency, tax, date or line details. Correct the source record through the supported accounting workflow first.");
  const source = parsed.data;
  if (!(input.sourceType === "INVOICE" ? ["SENT", "PAID"] : ["COMPLETED"]).includes(source.status) || source.refundedAmount > 0) throw new EInvoiceError("Only sent/paid invoices or unrefunded completed receipts can generate an e-invoice. Draft, void and refunded documents require the appropriate issue/credit-note workflow.", 409);
  if (source.businessSnapshot.countryCode !== input.seller.countryCode) throw new EInvoiceError("Supplier country must match the original document. Changing workspace country does not change historical invoices.");
  const currency = source.businessSnapshot.currency;
  const minor = (n: number) => currencyMinorUnits(n, currency);
  const scale = 10 ** currencyFractionDigits(currency);
  if (![source.total, source.netSales, source.tax, source.subtotal, source.discount, source.paidAmount, ...source.items.map(i => i.lineTotal)].every(n => Number.isSafeInteger(minor(n)))) throw new EInvoiceError("Invoice amounts exceed the safe accounting range.");
  if (minor(source.netSales) + minor(source.tax) !== minor(source.total) || source.items.reduce((s, i) => s + minor(i.lineTotal), 0) !== minor(source.subtotal) || source.discount > source.subtotal || source.paidAmount > source.total) throw new EInvoiceError("The source document does not reconcile. Resolve its line, discount, payment and tax totals before generating an e-invoice.");
  if (input.taxCategory === "S" && (source.taxRate <= 0 || source.tax <= 0)) throw new EInvoiceError("Choose the correct zero-tax treatment, not standard-rated tax.");
  if (input.taxCategory !== "S" && (source.tax > 0 || source.taxRate > 0)) throw new EInvoiceError("Tax treatment does not match the tax charged on the original document.");
  if (["E", "O"].includes(input.taxCategory) && !input.taxReason) throw new EInvoiceError("Explain the exemption or outside-scope treatment.");
  if (source.tax > 0 && !input.seller.taxId) throw new EInvoiceError("Enter the supplier’s tax registration / TIN.");
  const weights = source.items.map(i => minor(i.lineTotal));
  const nets = allocateInvoiceAmount(minor(source.netSales), weights);
  const taxes = allocateInvoiceAmount(minor(source.tax), nets);
  const number = input.sourceType === "INVOICE" ? source.invoiceNo : source.receiptNo;
  if (!number) throw new EInvoiceError("The source document needs a document number.");
  return {
    schema: "konkon.e-invoice.v1", status: "GENERATED_NOT_SUBMITTED", generatedAt: generatedAt.toISOString(),
    sourceType: input.sourceType, sourceId: input.sourceId, number, issueDate: dateKeyInTimeZone(source.createdAt, source.businessSnapshot.timeZone),
    ...(source.dueDate ? { dueDate: source.dueDate.toISOString().slice(0, 10) } : {}),
    currency, countryCode: input.seller.countryCode, seller: input.seller, buyer: input.buyer,
    taxCategory: input.taxCategory, taxReason: input.taxReason, taxRate: source.taxRate,
    lines: source.items.map((item, i) => ({ id: String(i + 1), description: item.description || item.name || `Item ${i + 1}`, quantity: item.quantity, unitCode: "C62", netAmount: nets[i] / scale, taxAmount: taxes[i] / scale, netUnitPrice: Number((nets[i] / scale / item.quantity).toFixed(10)) })),
    totals: { net: source.netSales, tax: source.tax, gross: source.total, paid: input.sourceType === "RECEIPT" ? source.total : source.paidAmount, payable: input.sourceType === "RECEIPT" ? 0 : roundCurrency(source.total - source.paidAmount, currency) },
    note: "Generated from the original transaction. Discounts and inclusive tax are allocated into net line amounts. Not submitted, signed or validated by a national tax authority or Peppol access point.",
  };
}
type Prepared = ReturnType<typeof prepareEInvoice>;
export const xmlEscape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function eInvoiceXml(doc: Prepared) {
  const tag = (name: string, value: unknown, attrs = "") => `<cbc:${name}${attrs}>${xmlEscape(value)}</cbc:${name}>`;
  const amt = (name: string, value: number) => tag(name, value.toFixed(currencyFractionDigits(doc.currency)), ` currencyID="${doc.currency}"`);
  const category = () => `<cac:TaxCategory>${tag("ID", doc.taxCategory)}${tag("Percent", doc.taxRate)}${doc.taxReason ? tag("TaxExemptionReason", doc.taxReason) : ""}<cac:TaxScheme>${tag("ID", "OTH")}</cac:TaxScheme></cac:TaxCategory>`;
  const party = (p: EInvoiceInput["seller"]) => `<cac:Party><cac:PartyName>${tag("Name", p.name)}</cac:PartyName><cac:PostalAddress>${tag("CityName", p.city)}${p.postalCode ? tag("PostalZone", p.postalCode) : ""}${p.stateCode ? tag("CountrySubentityCode", p.stateCode) : ""}<cac:AddressLine>${tag("Line", p.address)}</cac:AddressLine><cac:Country>${tag("IdentificationCode", p.countryCode)}</cac:Country></cac:PostalAddress>${p.taxId ? `<cac:PartyTaxScheme>${tag("CompanyID", p.taxId)}<cac:TaxScheme>${tag("ID", "OTH")}</cac:TaxScheme></cac:PartyTaxScheme>` : ""}<cac:PartyLegalEntity>${tag("RegistrationName", p.name)}${tag("CompanyID", p.registrationNo)}</cac:PartyLegalEntity><cac:Contact>${p.phone ? tag("Telephone", p.phone) : ""}${p.email ? tag("ElectronicMail", p.email) : ""}</cac:Contact></cac:Party>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">${tag("UBLVersionID", "2.1")}${tag("ID", doc.number)}${tag("IssueDate", doc.issueDate)}${doc.dueDate ? tag("DueDate", doc.dueDate) : ""}${tag("InvoiceTypeCode", "380")}${tag("Note", doc.note)}${tag("DocumentCurrencyCode", doc.currency)}<cac:AccountingSupplierParty>${party(doc.seller)}</cac:AccountingSupplierParty><cac:AccountingCustomerParty>${party(doc.buyer)}</cac:AccountingCustomerParty><cac:TaxTotal>${amt("TaxAmount", doc.totals.tax)}<cac:TaxSubtotal>${amt("TaxableAmount", doc.totals.net)}${amt("TaxAmount", doc.totals.tax)}${category()}</cac:TaxSubtotal></cac:TaxTotal><cac:LegalMonetaryTotal>${amt("LineExtensionAmount", doc.totals.net)}${amt("TaxExclusiveAmount", doc.totals.net)}${amt("TaxInclusiveAmount", doc.totals.gross)}${amt("PrepaidAmount", doc.totals.paid)}${amt("PayableAmount", doc.totals.payable)}</cac:LegalMonetaryTotal>${doc.lines.map(line => `<cac:InvoiceLine>${tag("ID", line.id)}${tag("InvoicedQuantity", line.quantity, ' unitCode="C62"')}${amt("LineExtensionAmount", line.netAmount)}<cac:Item>${tag("Description", line.description)}${tag("Name", line.description)}${category().replaceAll("cac:TaxCategory", "cac:ClassifiedTaxCategory")}</cac:Item><cac:Price>${tag("PriceAmount", line.netUnitPrice, ` currencyID="${doc.currency}"`)}${tag("BaseQuantity", 1, ' unitCode="C62"')}</cac:Price></cac:InvoiceLine>`).join("")}</Invoice>`;
}

export function myInvoisJson(doc: Prepared, input: EInvoiceInput) {
  const my = input.malaysia;
  if (!my || doc.countryCode !== "MY" || doc.buyer.countryCode !== "MY" || doc.currency !== "MYR") throw new EInvoiceError("The MyInvois 1.0 preparation adapter currently supports domestic Malaysian MYR invoices only. Use the general export for other documents; it is not a MyInvois submission.");
  if (doc.number.length > 50 || !doc.seller.taxId || !doc.buyer.taxId || !doc.seller.phone || !doc.buyer.phone || !/^\d{2}$/.test(doc.seller.stateCode) || !/^\d{2}$/.test(doc.buyer.stateCode)) throw new EInvoiceError("MyInvois requires both TINs, contact numbers, Malaysian state codes and a document number of at most 50 characters.");
  if ((["01", "02"].includes(my.taxType)) !== (doc.taxCategory === "S") || (my.taxType === "E" && doc.taxCategory !== "E") || (my.taxType === "06" && doc.taxCategory !== "O")) throw new EInvoiceError("Choose a Malaysian tax type matching the original tax treatment.");
  const val = (value: string | number, attrs: Record<string, string> = {}) => [{ _: value, ...attrs }];
  const amt = (value: number) => val(value, { currencyID: "MYR" });
  const category = () => [{ ID: val(my.taxType), ...(doc.taxReason ? { TaxExemptionReason: val(doc.taxReason) } : {}), TaxScheme: [{ ID: val("OTH", { schemeID: "UN/ECE 5153", schemeAgencyID: "6" }) }] }];
  const tax = (net: number, amount: number) => [{ TaxAmount: amt(amount), TaxSubtotal: [{ TaxableAmount: amt(net), TaxAmount: amt(amount), Percent: val(doc.taxRate), TaxCategory: category() }] }];
  const party = (p: EInvoiceInput["seller"], supplier: boolean) => [{ Party: [{ ...(supplier ? { IndustryClassificationCode: val(my.msic, { name: my.activity }) } : {}), PartyIdentification: [{ ID: val(p.taxId, { schemeID: "TIN" }) }, { ID: val(p.registrationNo, { schemeID: "BRN" }) }, { ID: val(supplier ? my.sellerSst : my.buyerSst, { schemeID: "SST" }) }], PostalAddress: [{ CityName: val(p.city), PostalZone: val(p.postalCode), CountrySubentityCode: val(p.stateCode), AddressLine: [{ Line: val(p.address) }], Country: [{ IdentificationCode: val("MYS", { listID: "ISO3166-1", listAgencyID: "6" }) }] }], PartyLegalEntity: [{ RegistrationName: val(p.name) }], Contact: [{ Telephone: val(p.phone), ...(p.email ? { ElectronicMail: val(p.email) } : {}) }] }] }];
  return JSON.stringify({ _D: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2", _A: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2", _B: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2", Invoice: [{ ID: val(doc.number), IssueDate: val(doc.generatedAt.slice(0, 10)), IssueTime: val(`${doc.generatedAt.slice(11, 19)}Z`), InvoiceTypeCode: val("01", { listVersionID: "1.0" }), DocumentCurrencyCode: val("MYR"), BillingReference: [{ AdditionalDocumentReference: [{ ID: val(doc.number), DocumentDescription: val(`Original transaction date ${doc.issueDate}`) }] }], AccountingSupplierParty: party(doc.seller, true), AccountingCustomerParty: party(doc.buyer, false), TaxTotal: tax(doc.totals.net, doc.totals.tax), LegalMonetaryTotal: [{ LineExtensionAmount: amt(doc.totals.net), TaxExclusiveAmount: amt(doc.totals.net), TaxInclusiveAmount: amt(doc.totals.gross), PrepaidAmount: amt(doc.totals.paid), PayableAmount: amt(doc.totals.payable) }], InvoiceLine: doc.lines.map(line => ({ ID: val(line.id), InvoicedQuantity: val(line.quantity, { unitCode: line.unitCode }), LineExtensionAmount: amt(line.netAmount), TaxTotal: tax(line.netAmount, line.taxAmount), Item: [{ CommodityClassification: [{ ItemClassificationCode: val(my.classification, { listID: "CLASS" }) }], Description: val(line.description) }], Price: [{ PriceAmount: amt(line.netUnitPrice) }], ItemPriceExtension: [{ Amount: amt(line.netAmount) }] })) }] }, null, 2);
}

export function generateEInvoice(raw: unknown, input: EInvoiceInput, now = new Date()) {
  const document = prepareEInvoice(raw, input, now);
  const content = input.format === "UBL_XML" ? eInvoiceXml(document) : input.format === "MYINVOIS_JSON" ? myInvoisJson(document, input) : JSON.stringify(document, null, 2);
  return { document, content, mimeType: input.format === "UBL_XML" ? "application/xml" : "application/json", filename: `${document.number.replace(/[^A-Za-z0-9._-]/g, "_")}-${input.format.toLowerCase()}.${input.format === "UBL_XML" ? "xml" : "json"}` };
}
