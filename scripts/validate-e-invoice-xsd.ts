// Optional release QA: official OASIS UBL 2.1 XSD + Python/lxml, never a national certification.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { eInvoiceInputSchema, generateEInvoice } from "../lib/e-invoices";

const [python, schema] = process.argv.slice(2);
assert.ok(python && schema, "Pass a Python executable with lxml and the official UBL-Invoice-2.1.xsd path.");
const party = { name: "Tea & Co", countryCode: "MY", registrationNo: "TEST-BRN", taxId: "TEST-TIN", address: "Tea Road", city: "Kuala Lumpur", postalCode: "50000", stateCode: "14", phone: "+60123456789", email: "test@example.com" };
for (const [currency, net, tax, rate] of [["MYR", 10, 0.6, 6], ["JPY", 101, 0, 0], ["KWD", 1.001, 0, 0], ["EUR", 100, 20, 20]] as const) {
  const input = eInvoiceInputSchema.parse({ sourceType: "INVOICE", sourceId: "a".repeat(24), clientRequestId: randomUUID(), format: "UBL_XML", seller: party, buyer: party, taxCategory: tax ? "S" : "O", taxReason: tax ? "" : "Outside tax scope", confirmed: true });
  const source = { invoiceNo: "INV-XSD", status: "SENT", createdAt: new Date(), dueDate: new Date("2026-12-31"), businessSnapshot: { currency, countryCode: "MY", timeZone: "Asia/Kuala_Lumpur" }, subtotal: net, netSales: net, tax, taxRate: rate, total: net + tax, items: [{ description: "Tea <Premium>", quantity: 1, lineTotal: net }] };
  const xml = generateEInvoice(source, input).content;
  const result = spawnSync(python, ["-c", "import sys\nfrom lxml import etree\np=etree.XMLParser(resolve_entities=False,no_network=True)\ns=etree.XMLSchema(etree.parse(sys.argv[1],p))\ns.assertValid(etree.fromstring(sys.stdin.buffer.read(),p))\nprint('OASIS UBL 2.1 XSD valid')", schema], { input: xml, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${currency}: ${result.stderr || result.error}`);
  console.log(`PASS ${currency}: ${result.stdout.trim()}`);
}
