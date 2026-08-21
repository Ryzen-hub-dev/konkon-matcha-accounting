import { asMoney } from "@/lib/format";
import { roundCurrency } from "@/lib/international";

export type TaxMode = "EXCLUSIVE" | "INCLUSIVE";

export function calculateTaxTotals(subtotalValue: number, discountValue: number, taxRateValue: number, taxMode: TaxMode, currency = "SGD") {
  const money = currency === "SGD" ? asMoney : (value: unknown) => roundCurrency(value, currency);
  const subtotal = Math.max(0, money(subtotalValue));
  const discount = Math.min(subtotal, Math.max(0, money(discountValue)));
  const taxRate = Math.max(0, Math.min(100, Number(taxRateValue || 0)));
  const discountedTotal = money(subtotal - discount);
  const tax = taxMode === "INCLUSIVE"
    ? money(taxRate ? discountedTotal * (taxRate / (100 + taxRate)) : 0)
    : money(discountedTotal * (taxRate / 100));
  const netSales = taxMode === "INCLUSIVE" ? money(discountedTotal - tax) : discountedTotal;
  const total = taxMode === "INCLUSIVE" ? discountedTotal : money(discountedTotal + tax);
  return { subtotal, discount, discountedTotal, taxRate, taxMode, tax, netSales, total };
}
