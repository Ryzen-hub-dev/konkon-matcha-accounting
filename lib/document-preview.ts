import type { BusinessSettings } from "@/lib/business-settings";
import type { InvoicePaperDocument } from "@/components/invoice-paper";
import type { ReceiptPaperDocument } from "@/components/receipt-paper";
import { roundCurrency } from "@/lib/international";
import { calculateTaxTotals } from "@/lib/tax";
import { dateKeyInTimeZone, shiftDateKey } from "@/lib/dates";

export function invoicePreview(profile: BusinessSettings, termsDays: number, now = new Date()): InvoicePaperDocument {
  const items = [
    { description: "Ceremonial matchā · 30g", quantity: 4, unitPrice: roundCurrency(46.9, profile.currency) },
    { description: "Purple bamboo chasen", quantity: 2, unitPrice: roundCurrency(18.9, profile.currency) },
  ].map(item => ({ ...item, lineTotal: roundCurrency(item.quantity * item.unitPrice, profile.currency) }));
  return {
    invoiceNo: "INV-PREVIEW", status: "DRAFT", createdAt: now,
    dueDate: shiftDateKey(dateKeyInTimeZone(now, profile.timeZone), termsDays),
    customerName: "Sample Tea Studio", customerEmail: "accounts@example.com", customerAddress: "Sample billing address",
    customerReference: "SAMPLE ORDER", items,
    ...calculateTaxTotals(items.reduce((sum, item) => sum + item.lineTotal, 0), 0, profile.taxRate, profile.taxMode, profile.currency),
    notes: "Sample amounts for preview only. Thank you for sharing our tea.", businessSnapshot: profile,
  };
}

export function receiptPreview(profile: BusinessSettings, now = new Date()): ReceiptPaperDocument {
  const items = [
    { sku: "MATCHA-A-30", name: "Gurēdo A Ceremonial · 30g", quantity: 1, price: roundCurrency(46.9, profile.currency) },
    { sku: "DOGU-CHASEN", name: "Purple bamboo chasen", quantity: 1, price: roundCurrency(18.9, profile.currency) },
  ].map(item => ({ ...item, lineTotal: roundCurrency(item.quantity * item.price, profile.currency) }));
  const totals = calculateTaxTotals(items.reduce((sum, item) => sum + item.lineTotal, 0), 5, profile.taxRate, profile.taxMode, profile.currency);
  const tenderedAmount = roundCurrency(Math.ceil(totals.total / 10) * 10, profile.currency);
  return {
    receiptNo: "KKM-PREVIEW", createdAt: now, cashierName: "Sample cashier", memberName: "Tea Club Member", memberNo: "MEM-PREVIEW",
    pointsEarned: Math.floor(totals.netSales * profile.pointsPerDollar), pointsBalance: 128, items, ...totals,
    paymentMethod: "CASH", tenderedAmount, changeDue: roundCurrency(tenderedAmount - totals.total, profile.currency), businessSnapshot: profile,
  };
}
