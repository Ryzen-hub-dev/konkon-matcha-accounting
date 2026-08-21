import { asMoney } from "@/lib/format";

export type TaxMode = "EXCLUSIVE" | "INCLUSIVE";

export function calculateTaxTotals(subtotalValue: number, discountValue: number, taxRateValue: number, taxMode: TaxMode) {
  const subtotal = Math.max(0, asMoney(subtotalValue));
  const discount = Math.min(subtotal, Math.max(0, asMoney(discountValue)));
  const taxRate = Math.max(0, Math.min(100, Number(taxRateValue || 0)));
  const discountedTotal = asMoney(subtotal - discount);
  const tax = taxMode === "INCLUSIVE"
    ? asMoney(taxRate ? discountedTotal * (taxRate / (100 + taxRate)) : 0)
    : asMoney(discountedTotal * (taxRate / 100));
  const netSales = taxMode === "INCLUSIVE" ? asMoney(discountedTotal - tax) : discountedTotal;
  const total = taxMode === "INCLUSIVE" ? discountedTotal : asMoney(discountedTotal + tax);
  return { subtotal, discount, discountedTotal, taxRate, taxMode, tax, netSales, total };
}
