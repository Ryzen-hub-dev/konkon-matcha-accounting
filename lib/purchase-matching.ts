import { createHash } from "node:crypto";
import { z } from "zod";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";

export const purchaseMatchActionSchema = z.object({
  id: z.string().regex(/^[a-fA-F0-9]{24}$/),
  expectedVersion: z.coerce.number().int().min(1),
  action: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().min(3).max(300),
});

export function purchaseInvoiceMatch(input: {
  purchaseOrderId: string;
  supplierInvoiceNo: string;
  invoiceDate: Date | string;
  expectedTotal: number;
  expectedTax: number;
  invoiceTotal: number;
  invoiceTax: number;
  currency: string;
  lines: Array<{ productId: string; quantity: number }>;
}) {
  const expectedTotal = roundCurrency(input.expectedTotal, input.currency);
  const expectedTax = roundCurrency(input.expectedTax, input.currency);
  const invoiceTotal = roundCurrency(input.invoiceTotal, input.currency);
  const invoiceTax = roundCurrency(input.invoiceTax, input.currency);
  if (currencyMinorUnits(invoiceTotal, input.currency) <= 0 || currencyMinorUnits(invoiceTax, input.currency) < 0 || currencyMinorUnits(invoiceTax, input.currency) > currencyMinorUnits(invoiceTotal, input.currency)) {
    throw new Error("Supplier invoice tax must be between zero and the positive invoice total.");
  }
  const lines = [...input.lines]
    .map(line => ({ productId: line.productId.toLowerCase(), quantity: line.quantity }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
  const invoiceDate = new Date(input.invoiceDate).toISOString().slice(0, 10);
  const supplierInvoiceNoNormalized = input.supplierInvoiceNo.trim().toUpperCase();
  const fingerprint = createHash("sha256").update(JSON.stringify({
    purchaseOrderId: input.purchaseOrderId.toLowerCase(), supplierInvoiceNoNormalized, invoiceDate,
    invoiceTotal: currencyMinorUnits(invoiceTotal, input.currency), invoiceTax: currencyMinorUnits(invoiceTax, input.currency),
    currency: input.currency.toUpperCase(), lines,
  })).digest("hex");
  return {
    matched: currencyMinorUnits(invoiceTotal, input.currency) === currencyMinorUnits(expectedTotal, input.currency)
      && currencyMinorUnits(invoiceTax, input.currency) === currencyMinorUnits(expectedTax, input.currency),
    expectedTotal,
    expectedTax,
    invoiceTotal,
    invoiceTax,
    invoiceNet: roundCurrency(invoiceTotal - invoiceTax, input.currency),
    totalVariance: roundCurrency(invoiceTotal - expectedTotal, input.currency),
    taxVariance: roundCurrency(invoiceTax - expectedTax, input.currency),
    supplierInvoiceNoNormalized,
    invoiceDate,
    lines,
    fingerprint,
  };
}
