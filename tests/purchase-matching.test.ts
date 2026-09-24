import assert from "node:assert/strict";
import test from "node:test";
import { purchaseInvoiceMatch, purchaseMatchActionSchema } from "../lib/purchase-matching";

const base = {
  purchaseOrderId: "a".repeat(24), supplierInvoiceNo: " inv-77 ", invoiceDate: "2026-09-22",
  expectedTotal: 109, expectedTax: 9, invoiceTotal: 109, invoiceTax: 9, currency: "MYR",
  lines: [{ productId: "c".repeat(24), quantity: 2 }, { productId: "b".repeat(24), quantity: 1 }],
};

test("three-way match fingerprints exact invoice evidence independent of line order", () => {
  const match = purchaseInvoiceMatch(base);
  assert.equal(match.matched, true);
  assert.equal(match.invoiceNet, 100);
  assert.equal(match.supplierInvoiceNoNormalized, "INV-77");
  assert.equal(match.fingerprint, purchaseInvoiceMatch({ ...base, lines: [...base.lines].reverse() }).fingerprint);
  assert.notEqual(match.fingerprint, purchaseInvoiceMatch({ ...base, invoiceTotal: 110 }).fingerprint);
});

test("three-way variance and approval evidence use currency precision", () => {
  const mismatch = purchaseInvoiceMatch({ ...base, invoiceTotal: 110.004, invoiceTax: 9.5 });
  assert.equal(mismatch.matched, false);
  assert.equal(mismatch.totalVariance, 1);
  assert.equal(mismatch.taxVariance, 0.5);
  assert.throws(() => purchaseInvoiceMatch({ ...base, invoiceTotal: 5, invoiceTax: 6 }), /tax/i);
  assert.equal(purchaseMatchActionSchema.safeParse({ id: "d".repeat(24), expectedVersion: 1, action: "APPROVE", note: "Invoice price confirmed" }).success, true);
  assert.equal(purchaseMatchActionSchema.safeParse({ id: "d".repeat(24), expectedVersion: 1, action: "REJECT", note: "x" }).success, false);
});
