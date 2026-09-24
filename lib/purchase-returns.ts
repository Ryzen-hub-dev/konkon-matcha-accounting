import { createHash } from "node:crypto";
import { z } from "zod";
import { currencyFractionDigits, currencyMinorUnits } from "@/lib/international";
import { allocateMinorUnits, sliceMinorUnits } from "@/lib/minor-unit-allocation";

export const purchaseReturnSchema = z.object({
  billId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid supplier bill.").transform(value => value.toLowerCase()),
  clientRequestId: z.string().uuid(),
  supplierCreditNo: z.string().trim().min(2).max(80),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  returnedAt: z.coerce.date(),
  reason: z.string().trim().min(3).max(300),
  lines: z.array(z.object({
    productId: z.string().regex(/^[a-fA-F0-9]{24}$/).transform(value => value.toLowerCase()),
    quantity: z.coerce.number().int().min(1).max(1_000_000),
  })).min(1).max(100),
}).superRefine((value, context) => {
  const ids = value.lines.map(line => line.productId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["lines"], message: "Return each product only once." });
});

type ReceiptLine = {
  quantity: number;
  lineTotal: number;
  allocationWeight?: number;
  baseInventoryValue: number;
  [key: string]: unknown;
};

export function allocatePurchaseReceiptLineFinancials<T extends ReceiptLine>(items: T[], totals: {
  netSales: number; tax: number; total: number; baseTax: number;
}, currency: string, baseCurrency: string) {
  if (!items.length) throw new Error("A goods receipt needs at least one line.");
  const supplierScale = 10 ** currencyFractionDigits(currency);
  const baseScale = 10 ** currencyFractionDigits(baseCurrency);
  const weights = items.map(item => currencyMinorUnits(item.allocationWeight ?? item.lineTotal, currency));
  const net = allocateMinorUnits(currencyMinorUnits(totals.netSales, currency), weights, "Purchase receipt amounts cannot be reconciled.");
  const gross = allocateMinorUnits(currencyMinorUnits(totals.total, currency), weights, "Purchase receipt amounts cannot be reconciled.");
  const baseInventory = items.map(item => currencyMinorUnits(item.baseInventoryValue, baseCurrency));
  const baseTax = allocateMinorUnits(currencyMinorUnits(totals.baseTax, baseCurrency), baseInventory, "Purchase receipt base amounts cannot be reconciled.");
  return items.map((item, index) => ({
    ...item,
    lineNetAmount: net[index] / supplierScale,
    lineTax: (gross[index] - net[index]) / supplierScale,
    lineGross: gross[index] / supplierScale,
    baseTax: baseTax[index] / baseScale,
    baseTotal: (baseInventory[index] + baseTax[index]) / baseScale,
  }));
}

export function slicePurchaseReturnLine(line: ReceiptLine & {
  lineNetAmount: number; lineTax: number; lineGross: number; baseTax: number; baseTotal: number;
}, alreadyReturned: number, quantity: number, currency: string, baseCurrency: string) {
  const supplierScale = 10 ** currencyFractionDigits(currency);
  const baseScale = 10 ** currencyFractionDigits(baseCurrency);
  const supplier = (value: unknown) => sliceMinorUnits(currencyMinorUnits(value, currency), line.quantity, alreadyReturned, quantity, "Purchase return amounts cannot be reconciled.");
  const base = (value: unknown) => sliceMinorUnits(currencyMinorUnits(value, baseCurrency), line.quantity, alreadyReturned, quantity, "Purchase return base amounts cannot be reconciled.");
  const supplierNet = supplier(line.lineNetAmount);
  const supplierTotal = supplier(line.lineGross);
  const originalBaseInventory = base(line.baseInventoryValue);
  const baseTotal = base(line.baseTotal);
  return {
    supplierNet: supplierNet / supplierScale,
    supplierTax: (supplierTotal - supplierNet) / supplierScale,
    supplierTotal: supplierTotal / supplierScale,
    originalBaseInventory: originalBaseInventory / baseScale,
    baseTax: (baseTotal - originalBaseInventory) / baseScale,
    baseTotal: baseTotal / baseScale,
  };
}

export function purchaseReturnObjectId(clientRequestId: string) {
  return createHash("sha256").update(`purchase-return:${clientRequestId.toLowerCase()}`).digest("hex").slice(0, 24);
}

export class PurchaseReturnError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
