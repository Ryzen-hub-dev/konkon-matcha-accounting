import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  eInvoiceInputSchema,
  generateEInvoice,
  allocateInvoiceAmount,
  prepareEInvoice,
} from "../lib/e-invoices";
import {
  countryWorksheet,
  countryReportPack,
  countryReportCsv,
  type StatementExport,
} from "../lib/country-reporting";
import { COUNTRY_PROFILES } from "../lib/international";
import { scannerPermission } from "../lib/scanner-routing";

const party = {
  name: "Tea & Co <Trading>",
  countryCode: "MY",
  registrationNo: "BRN123",
  taxId: "C12345678",
  address: "Lot 1, Tea Road",
  city: "Kuala Lumpur",
  postalCode: "50000",
  stateCode: "14",
  phone: "+60123456789",
  email: "test@example.com",
};
const input = () =>
  eInvoiceInputSchema.parse({
    sourceType: "INVOICE",
    sourceId: "a".repeat(24),
    clientRequestId: randomUUID(),
    format: "UBL_XML",
    seller: party,
    buyer: party,
    taxCategory: "S",
    confirmed: true,
  });
const source = {
  invoiceNo: "INV-001",
  status: "SENT",
  createdAt: new Date("2026-08-01T18:00:00Z"),
  businessSnapshot: {
    currency: "MYR",
    countryCode: "MY",
    timeZone: "Asia/Kuala_Lumpur",
  },
  subtotal: 10.6,
  netSales: 10,
  tax: 0.6,
  taxRate: 6,
  total: 10.6,
  paidAmount: 0,
  items: [
    { description: "Matcha <premium> & tea", quantity: 2, lineTotal: 10.6 },
  ],
};

test("e-invoice uses historical currency, country and local date with safe XML escaping", () => {
  const generated = generateEInvoice(source, input());
  assert.equal(generated.document.issueDate, "2026-08-02");
  assert.equal(generated.document.totals.gross, 10.6);
  assert.equal(generated.document.lines[0].netUnitPrice, 5);
  assert.match(generated.content, /Tea &amp; Co &lt;Trading&gt;/);
  assert.match(generated.content, /<cbc:PayableAmount currencyID="MYR">10.60/);
  assert.equal(generated.document.status, "GENERATED_NOT_SUBMITTED");
  assert.doesNotMatch(generated.content, /CustomizationID|ProfileID/);
  assert.throws(
    () =>
      generateEInvoice(source, {
        ...input(),
        seller: { ...party, countryCode: "SG" },
      }),
    /Supplier country/,
  );
});
test("minor-unit allocation reconciles discounts, rounding, zero amounts and large exact weights", () => {
  assert.deepEqual(allocateInvoiceAmount(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocateInvoiceAmount(0, [0, 0]), [0, 0]);
  assert.deepEqual(
    allocateInvoiceAmount(9, [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]),
    [3, 3, 3],
  );
  assert.throws(() => allocateInvoiceAmount(1, [0]), /reconciled/);
  const doc = prepareEInvoice(
    {
      ...source,
      subtotal: 12,
      discount: 1.4,
      items: [
        { name: "A", quantity: 1, lineTotal: 4 },
        { name: "B", quantity: 1, lineTotal: 4 },
        { name: "C", quantity: 1, lineTotal: 4 },
      ],
    },
    input(),
  );
  assert.deepEqual(
    doc.lines.map((line) => line.netAmount),
    [3.34, 3.33, 3.33],
  );
  assert.equal(
    doc.lines.reduce((s, line) => s + Math.round(line.taxAmount * 100), 0),
    60,
  );
});
test("zero and three-decimal currencies keep their precision without assumed Singapore defaults", () => {
  for (const [currency, amount] of [
    ["JPY", 101],
    ["KWD", 1.001],
  ] as const) {
    const data = {
      ...source,
      businessSnapshot: { ...source.businessSnapshot, currency },
      subtotal: amount,
      netSales: amount,
      tax: 0,
      taxRate: 0,
      total: amount,
      items: [{ name: "Tea", quantity: 1, lineTotal: amount }],
    };
    const result = generateEInvoice(data, {
      ...input(),
      taxCategory: "O",
      taxReason: "Not registered",
    });
    assert.equal(result.document.totals.gross, amount);
    assert.match(
      result.content,
      new RegExp(`currencyID="${currency}">${amount}<`),
    );
  }
  assert.throws(
    () => generateEInvoice({ ...source, businessSnapshot: {} }, input()),
    /historical document/,
  );
});
test("invalid source states, unreconciled totals, tax mismatch and invalid parties cannot generate", () => {
  for (const status of ["DRAFT", "VOID", "REFUNDED", "PARTIALLY_REFUNDED"])
    assert.throws(
      () => generateEInvoice({ ...source, status }, input()),
      /Only final/,
    );
  assert.throws(
    () => generateEInvoice({ ...source, total: 99 }, input()),
    /reconcile/,
  );
  assert.throws(
    () => generateEInvoice(source, { ...input(), taxCategory: "O" }),
    /Tax treatment/,
  );
  assert.throws(
    () => generateEInvoice({ ...source, paidAmount: 99 }, input()),
    /reconcile/,
  );
  assert.equal(
    eInvoiceInputSchema.safeParse({
      ...input(),
      seller: { ...party, name: "\x01hidden" },
    }).success,
    false,
  );
  assert.equal(
    eInvoiceInputSchema.safeParse({
      ...input(),
      seller: { ...party, name: "\x01hidden" },
    }).success,
    false,
  );
  assert.equal(
    eInvoiceInputSchema.safeParse({ ...input(), confirmed: false }).success,
    false,
  );
});
test("MyInvois preparation uses required UBL JSON wrappers, UTC issue time and no fake signatures", () => {
  const malaysia = {
    documentType: "01" as const,
    transactionMode: "STANDARD" as const,
    referenceDocumentNo: "",
    referenceDocumentUuid: "",
    msic: "56101",
    activity: "Restaurant",
    classification: "022",
    taxType: "02" as const,
    sellerSst: "SST123",
    buyerSst: "NA",
  };
  const result = generateEInvoice(
    source,
    { ...input(), format: "MYINVOIS_JSON", malaysia },
    new Date("2026-09-01T10:20:30Z"),
  );
  const doc = JSON.parse(result.content).Invoice[0];
  assert.deepEqual(doc.InvoiceTypeCode, [{ _: "01", listVersionID: "1.0" }]);
  assert.equal(doc.IssueTime[0]._, "10:20:30Z");
  assert.equal(
    doc.AccountingSupplierParty[0].Party[0].PostalAddress[0].Country[0]
      .IdentificationCode[0]._,
    "MYS",
  );
  assert.equal(doc.LegalMonetaryTotal[0].TaxInclusiveAmount[0]._, 10.6);
  assert.doesNotMatch(result.content, /Signature|ValidationLink|Submitted/);
  assert.throws(
    () =>
      generateEInvoice(source, {
        ...input(),
        format: "MYINVOIS_JSON",
        malaysia,
        buyer: { ...party, countryCode: "SG" },
      }),
    /Malaysian buyers/,
  );
});
test("MyInvois supports standard adjustments, consolidated receipts and self-billed type codes", () => {
  const baseMalaysia = {
    transactionMode: "STANDARD" as const,
    referenceDocumentNo: "INV-ORIGINAL",
    referenceDocumentUuid: "LHDN-UUID-ORIGINAL",
    msic: "56101",
    activity: "Restaurant",
    classification: "022",
    taxType: "02" as const,
    sellerSst: "SST123",
    buyerSst: "NA",
  };
  for (const documentType of ["01", "02", "03", "04"] as const) {
    const result = generateEInvoice(source, {
      ...input(),
      format: "MYINVOIS_JSON",
      malaysia: { ...baseMalaysia, documentType },
    });
    assert.equal(
      JSON.parse(result.content).Invoice[0].InvoiceTypeCode[0]._,
      documentType,
    );
  }
  const receiptInput = eInvoiceInputSchema.parse({
    ...input(),
    sourceType: "RECEIPT",
    format: "MYINVOIS_JSON",
    malaysia: {
      ...baseMalaysia,
      documentType: "01",
      transactionMode: "CONSOLIDATED",
      classification: "004",
    },
  });
  const receiptSource = {
    ...source,
    invoiceNo: undefined,
    receiptNo: "RCP-001",
    status: "COMPLETED",
    paidAmount: source.total,
  };
  const consolidated = JSON.parse(
    generateEInvoice(receiptSource, receiptInput).content,
  ).Invoice[0];
  assert.equal(
    consolidated.AccountingCustomerParty[0].Party[0].PartyIdentification[0]
      .ID[0]._,
    "EI00000000010",
  );
  for (const documentType of ["11", "12", "13", "14"] as const) {
    const purchaseInput = eInvoiceInputSchema.parse({
      ...input(),
      sourceType: "PURCHASE_BILL",
      format: "MYINVOIS_JSON",
      malaysia: { ...baseMalaysia, documentType },
    });
    const purchaseSource = {
      ...source,
      status: "OPEN",
      invoiceNo: "APB-001",
    };
    assert.equal(
      JSON.parse(generateEInvoice(purchaseSource, purchaseInput).content)
        .Invoice[0].InvoiceTypeCode[0]._,
      documentType,
    );
  }
});
test("all 249 countries have honest report capabilities and empty figures never become zero", () => {
  assert.equal(COUNTRY_PROFILES.length, 249);
  for (const country of COUNTRY_PROFILES)
    assert.ok(countryReportPack(country.code).fields.length);
  assert.throws(() => countryReportPack("ZZ"));
  assert.equal(
    countryWorksheet("SG", {}).rows.find((row) => row.code === "4")?.amount,
    null,
  );
  assert.equal(
    countryWorksheet("SG", { "1": "100", "2": "20", "3": "0" }).rows.find(
      (row) => row.code === "4",
    )?.amount,
    120,
  );
  assert.equal(
    countryWorksheet("GB", { "1": "10", "2": "0", "4": "20" }).rows.find(
      (row) => row.code === "5",
    )?.amount,
    10,
  );
  assert.match(countryReportPack("MY").note, /not a VAT input-credit/);
  assert.match(countryReportPack("CN").note, /No national tax-return adapter/);
  assert.throws(() => countryWorksheet("AU", { G1: "1e1000" }), /Check/);
});
test("country report export protects formulas, preserves book currency and includes all ledger statements", () => {
  const line = { code: "4000", name: "=EVIL()", amount: 42 };
  const data: StatementExport = {
    period: {
      from: "2026-01-01",
      to: "2026-01-31",
      currency: "MYR",
      timeZone: "Asia/Kuala_Lumpur",
    },
    profitAndLoss: { revenue: [line], expenses: [], netProfit: 42 },
    balanceSheet: { assets: [], liabilities: [], equity: [] },
    cashFlow: {
      operating: [],
      investing: [],
      financing: [],
      unclassified: [],
      openingCash: 0,
      closingCash: 42,
    },
    trialBalance: { rows: [] },
    tax: {
      outputTaxCharged: 0,
      outputTaxAdjustments: 0,
      inputTaxRecoverable: 0,
      inputTaxAdjustments: 0,
      netMovement: 0,
    },
    integrity: { balanced: true },
  };
  const csv = countryReportCsv(data, "SG", {}, "+BAD()");
  assert.match(csv, /'\+BAD/);
  assert.match(csv, /'=EVIL/);
  assert.match(csv, /"MYR"/);
  assert.match(csv, /WORKING_PAPER_NOT_FILED/);
  assert.match(csv, /Trial balance/);
  assert.match(csv, /NOT_REVIEWED/);
  assert.equal(scannerPermission("MEMBER_BIND"), "members.write");
});
