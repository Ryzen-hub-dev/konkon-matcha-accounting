import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import type { ResolvedDimensionAllocation } from "../lib/dimension-allocation";
import type { DocumentDimensionSelection } from "../lib/dimension-selection";
import { allocateSaleItemFinancials, buildClassifiedPosJournalLines, sliceRefundItemFinancials } from "../lib/pos-accounting";

const cents = (value: unknown) => Math.round(Number(value || 0) * 100);

test("POS item allocation keeps discounts, tax and payment exact to the minor unit", () => {
  const items = allocateSaleItemFinancials([
    { name: "Ceremonial", quantity: 1, lineTotal: 0.01, lineCost: 0.01 },
    { name: "Daily", quantity: 1, lineTotal: 0.01, lineCost: 0.01 },
    { name: "Hojicha", quantity: 1, lineTotal: 0.01, lineCost: 0.01 },
  ], { discount: 0.01, netSales: 0.02, tax: 0, total: 0.02 }, "MYR");

  assert.deepEqual(items.map(item => item.lineDiscount), [0.01, 0, 0]);
  assert.equal(items.reduce((sum, item) => sum + cents(item.lineDiscount), 0), 1);
  assert.equal(items.reduce((sum, item) => sum + cents(item.lineNetSales), 0), 2);
  assert.equal(items.reduce((sum, item) => sum + cents(item.lineGross), 0), 2);
});

test("repeated partial refunds add back to the frozen sale item without rounding drift", () => {
  const [item] = allocateSaleItemFinancials([
    { name: "Three tins", quantity: 3, lineTotal: 10, lineCost: 4 },
  ], { discount: 0.01, netSales: 9.99, tax: 0.6, total: 10.59 }, "MYR");
  const first = sliceRefundItemFinancials(item, 0, 1, "MYR");
  const second = sliceRefundItemFinancials(item, 1, 1, "MYR");
  const final = sliceRefundItemFinancials(item, 2, 1, "MYR");

  assert.ok(first && second && final);
  for (const part of [first, second, final]) {
    assert.equal(cents(part.lineGross), cents(part.lineNetSales) + cents(part.lineTax));
    assert.equal(cents(part.lineSubtotal) - cents(part.lineDiscount), cents(part.lineNetSales));
  }
  for (const field of ["lineSubtotal", "lineDiscount", "lineNetSales", "lineTax", "lineGross", "lineCost"] as const) {
    assert.equal(cents(first[field]) + cents(second[field]) + cents(final[field]), cents(field === "lineSubtotal" ? item.lineTotal : item[field]));
  }
});

test("inclusive-tax partial refunds preserve both line and journal identities", () => {
  const [item] = allocateSaleItemFinancials([
    { name: "Inclusive bundle", quantity: 3, lineTotal: 0.07, lineCost: 0.03 },
  ], { discount: 0.01, netSales: 0.04, tax: 0.02, total: 0.06, taxMode: "INCLUSIVE" }, "MYR");
  const parts = [
    sliceRefundItemFinancials(item, 0, 1, "MYR", "INCLUSIVE")!,
    sliceRefundItemFinancials(item, 1, 1, "MYR", "INCLUSIVE")!,
    sliceRefundItemFinancials(item, 2, 1, "MYR", "INCLUSIVE")!,
  ];

  for (const part of parts) {
    assert.equal(cents(part.lineSubtotal) - cents(part.lineDiscount), cents(part.lineGross));
    assert.equal(cents(part.lineNetSales) + cents(part.lineTax), cents(part.lineGross));
  }
  assert.equal(parts.reduce((sum, part) => sum + cents(part.lineGross), 0), cents(item.lineGross));
  assert.equal(parts.reduce((sum, part) => sum + cents(part.lineDiscount), 0), cents(item.lineDiscount));
});

test("multi-product POS journals use product defaults and location fallback while remaining balanced", () => {
  const productSelection: DocumentDimensionSelection = {
    mode: "CUSTOM",
    source: "PRODUCT_MASTER",
    productId: new ObjectId(),
    costCentre: { id: new ObjectId(), code: "MATCHA", name: "Matcha retail" },
    resolvedAt: new Date("2026-09-19T00:00:00.000Z"),
  };
  const fallback: ResolvedDimensionAllocation = {
    allocations: [
      { percentage: 60, costCentre: { id: new ObjectId(), code: "KL", name: "Kuala Lumpur" } },
      { percentage: 40, costCentre: { id: new ObjectId(), code: "PJ", name: "Petaling Jaya" } },
    ],
    rule: { id: new ObjectId(), source: "POS_LOCATION", matchKey: new ObjectId().toHexString(), version: 2 },
  };
  const common = {
    currency: "MYR",
    total: 28.62,
    tax: 1.62,
    paymentAccount: { code: "1000", name: "Cash on hand" },
    items: [
      { productId: new ObjectId(), sku: "MATCHA", name: "Matcha", lineNetSales: 18, lineTax: 1.08, lineGross: 19.08, lineCost: 8, dimensionSelection: productSelection },
      { productId: new ObjectId(), sku: "HOJICHA", name: "Hojicha", lineNetSales: 9, lineTax: 0.54, lineGross: 9.54, lineCost: 4 },
    ],
    fallbackAllocation: fallback,
  };
  const lines = buildClassifiedPosJournalLines({ kind: "SALE", ...common });

  assert.equal(lines.reduce((sum, line) => sum + cents(line.debit), 0), lines.reduce((sum, line) => sum + cents(line.credit), 0));
  const productLines = lines.filter(line => line.productSku === "MATCHA");
  assert.equal(productLines.length, 3);
  assert.ok(productLines.every(line => line.costCentre?.code === "MATCHA" && line.dimensionSource?.type === "PRODUCT_MASTER"));
  const fallbackProductLines = lines.filter(line => line.productSku === "HOJICHA");
  assert.equal(fallbackProductLines.length, 6);
  assert.ok(fallbackProductLines.every(line => line.dimensionRule?.source === "POS_LOCATION"));
  assert.deepEqual(lines.filter(line => line.accountCode === "1000").map(line => line.debit), [17.17, 11.45]);
});

test("refund journals reverse the same frozen product classifications", () => {
  const selection: DocumentDimensionSelection = {
    mode: "CUSTOM",
    source: "PRODUCT_MASTER",
    productId: new ObjectId(),
    project: { id: new ObjectId(), code: "POPUP", name: "Pop-up store" },
    resolvedAt: new Date("2026-09-19T00:00:00.000Z"),
  };
  const lines = buildClassifiedPosJournalLines({
    kind: "REFUND",
    currency: "MYR",
    total: 10.6,
    tax: 0.6,
    paymentAccount: { code: "1010", name: "Bank" },
    items: [{ name: "Frozen item", lineNetSales: 10, lineTax: 0.6, lineGross: 10.6, lineCost: 4, dimensionSelection: selection }],
  });

  assert.equal(lines.reduce((sum, line) => sum + cents(line.debit), 0), lines.reduce((sum, line) => sum + cents(line.credit), 0));
  assert.equal(lines.find(line => line.accountCode === "4000")?.debit, 10);
  assert.equal(lines.find(line => line.accountCode === "1200")?.debit, 4);
  assert.equal(lines.find(line => line.accountCode === "5000")?.credit, 4);
  assert.ok(lines.filter(line => ["4000", "1200", "5000"].includes(line.accountCode)).every(line => line.project?.code === "POPUP"));
});
