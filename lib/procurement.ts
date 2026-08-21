import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { countryCodeSchema, currencyCodeSchema, currencyMinorUnits, roundCurrency } from "@/lib/international";

const supplierFields = z.object({
  code: z.string().trim().toUpperCase().min(2).max(32).regex(/^[A-Z0-9_-]+$/),
  name: z.string().trim().min(2).max(120),
  contactName: z.string().trim().max(100).default(""),
  registrationNo: z.string().trim().max(60).default(""),
  taxNo: z.string().trim().max(60).default(""),
  email: z.union([z.string().trim().email(), z.literal("")]).default(""),
  phone: z.string().trim().max(40).default(""),
  address: z.string().trim().max(300).default(""),
  countryCode: countryCodeSchema,
  currency: currencyCodeSchema,
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(7),
  minimumOrder: z.coerce.number().min(0).max(100_000_000).default(0),
  notes: z.string().trim().max(500).default(""),
});

export const supplierInputSchema = supplierFields;
export const supplierUpdateSchema = supplierFields.partial().extend({
  id: z.string().length(24),
  restore: z.boolean().optional(),
}).refine((value) => value.restore || Object.keys(value).some((key) => key !== "id"), "Add at least one supplier change.");

const purchaseLineSchema = z.object({
  productId: z.string().length(24),
  quantity: z.coerce.number().int().min(1).max(1_000_000),
  unitCost: z.coerce.number().positive().max(100_000_000),
});

export const purchaseOrderInputSchema = z.object({
  clientRequestId: z.string().uuid(),
  supplierId: z.string().length(24),
  locationId: z.string().length(24),
  expectedDate: z.coerce.date(),
  supplierReference: z.string().trim().max(80).default(""),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  taxMode: z.enum(["EXCLUSIVE", "INCLUSIVE"]).default("EXCLUSIVE"),
  notes: z.string().trim().max(500).default(""),
  items: z.array(purchaseLineSchema).min(1).max(100),
}).superRefine((value, context) => {
  const ids = value.items.map((item) => item.productId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["items"], message: "Each product can appear only once on a purchase order." });
});

const actionBase = z.object({ id: z.string().length(24) });
export const purchaseOrderActionSchema = z.discriminatedUnion("action", [
  actionBase.extend({ action: z.literal("APPROVE") }),
  actionBase.extend({ action: z.literal("CANCEL"), reason: z.string().trim().min(3).max(200) }),
  actionBase.extend({
    action: z.literal("RECEIVE"),
    clientRequestId: z.string().uuid(),
    supplierInvoiceNo: z.string().trim().min(2).max(80),
    invoiceDate: z.coerce.date(),
    receivedAt: z.coerce.date().default(() => new Date()),
    notes: z.string().trim().max(300).default(""),
    lines: z.array(z.object({ productId: z.string().length(24), quantity: z.coerce.number().int().min(1).max(1_000_000) })).min(1).max(100),
  }).superRefine((value, context) => {
    const ids = value.lines.map((line) => line.productId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["lines"], message: "Each received product can appear only once." });
  }),
]);

export const supplierPaymentSchema = z.object({
  id: z.string().length(24),
  clientRequestId: z.string().uuid(),
  amount: z.coerce.number().positive().max(100_000_000),
  paymentAccountCode: z.string().trim().min(1).max(20),
  reference: z.string().trim().min(2).max(100),
  paidAt: z.coerce.date(),
  notes: z.string().trim().max(300).default(""),
});

export type SupplierPulseInput = {
  receiptCount: number;
  onTimeReceiptCount: number;
  lateDaysTotal: number;
  overdueOrderCount: number;
};

export function supplierPulse(input: SupplierPulseInput) {
  const receiptCount = Math.max(0, Math.trunc(input.receiptCount || 0));
  const onTimeReceiptCount = Math.min(receiptCount, Math.max(0, Math.trunc(input.onTimeReceiptCount || 0)));
  const punctuality = receiptCount ? Math.round((onTimeReceiptCount / receiptCount) * 100) : null;
  const averageLateDays = receiptCount ? Math.round((Math.max(0, input.lateDaysTotal || 0) / receiptCount) * 10) / 10 : 0;
  const score = Math.max(0, Math.min(100, Math.round(
    100
    - (punctuality === null ? 0 : (100 - punctuality) * 0.45)
    - Math.min(averageLateDays * 3, 30)
    - Math.min(Math.max(0, input.overdueOrderCount || 0) * 12, 36),
  )));
  const risk = score >= 85 ? "STABLE" : score >= 65 ? "WATCH" : "AT_RISK";
  return { score, risk, punctuality, averageLateDays } as const;
}

export function suggestedReorderQuantity(stockValue: unknown, reorderLevelValue: unknown, recent30DayUnitsValue: unknown = 0, leadTimeDaysValue: unknown = 14) {
  const stock = Math.max(0, Math.trunc(Number(stockValue) || 0));
  const reorderLevel = Math.max(0, Math.trunc(Number(reorderLevelValue) || 0));
  if (stock > reorderLevel) return 0;
  const recent30DayUnits = Math.max(0, Number(recent30DayUnitsValue) || 0);
  const leadTimeDays = Math.max(0, Math.trunc(Number(leadTimeDaysValue) || 0));
  const demandTarget = Math.ceil((recent30DayUnits / 30) * leadTimeDays) + reorderLevel;
  return Math.max(1, Math.max(reorderLevel * 2, demandTarget) - stock);
}

export function suggestedReorderAfterInbound(stockValue: unknown, reorderLevelValue: unknown, recent30DayUnitsValue: unknown, leadTimeDaysValue: unknown, inboundQuantityValue: unknown) {
  const recommendation = suggestedReorderQuantity(stockValue, reorderLevelValue, recent30DayUnitsValue, leadTimeDaysValue);
  const inboundQuantity = Math.max(0, Math.trunc(Number(inboundQuantityValue) || 0));
  return Math.max(0, recommendation - inboundQuantity);
}

export function approvalRequiresDifferentMaker(role: string) {
  return role !== "OWNER";
}

export function weightedAverageInventoryCost(oldStockValue: unknown, oldUnitCostValue: unknown, receivedQuantityValue: unknown, receivedBaseValueValue: unknown, currency: string) {
  const oldStock = Math.max(0, Number(oldStockValue) || 0);
  const oldUnitCost = Math.max(0, Number(oldUnitCostValue) || 0);
  const receivedQuantity = Math.max(0, Number(receivedQuantityValue) || 0);
  const receivedBaseValue = Math.max(0, Number(receivedBaseValueValue) || 0);
  const newStock = oldStock + receivedQuantity;
  return newStock ? roundCurrency(((oldStock * oldUnitCost) + receivedBaseValue) / newStock, currency) : 0;
}

export function allocateSupplierPayment(input: {
  total: number;
  baseTotal: number;
  balance: number;
  baseBalance: number;
  amount: number;
  exchangeRate: number;
  currency: string;
  baseCurrency: string;
}) {
  const amount = roundCurrency(input.amount, input.currency);
  const finalPayment = currencyMinorUnits(amount, input.currency) === currencyMinorUnits(input.balance, input.currency);
  const carryingBaseAmount = finalPayment
    ? roundCurrency(input.baseBalance, input.baseCurrency)
    : roundCurrency(Math.min(input.baseBalance, input.baseTotal * (amount / input.total)), input.baseCurrency);
  const baseCashAmount = roundCurrency(amount / input.exchangeRate, input.baseCurrency);
  const exchangeDifference = roundCurrency(baseCashAmount - carryingBaseAmount, input.baseCurrency);
  return {
    amount,
    finalPayment,
    carryingBaseAmount,
    baseCashAmount,
    exchangeLoss: Math.max(0, exchangeDifference),
    exchangeGain: Math.max(0, -exchangeDifference),
  };
}

export const PROCUREMENT_ACCOUNTS = [
  { code: "1300", name: "Input tax recoverable", type: "ASSET" },
  { code: "4100", name: "Foreign exchange gain", type: "REVENUE" },
  { code: "6200", name: "Foreign exchange loss", type: "EXPENSE" },
] as const;

export async function ensureProcurementAccounts(db: Db, createdBy?: unknown, session?: ClientSession) {
  const now = new Date();
  await db.collection("chartOfAccounts").bulkWrite(PROCUREMENT_ACCOUNTS.map((account) => ({
    updateOne: {
      filter: { code: account.code },
      update: { $setOnInsert: { ...account, active: true, createdBy: createdBy || null, createdAt: now } },
      upsert: true,
    },
  })), session ? { session } : undefined);
}
