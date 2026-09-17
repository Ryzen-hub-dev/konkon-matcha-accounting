import { ObjectId, type ClientSession, type Db } from "mongodb";
import { z } from "zod";
import { currencyCodeSchema, currencyMinorUnits, roundCurrency } from "@/lib/international";

export const REGISTER_SHIFT_STATUSES = ["OPEN", "PENDING_REVIEW", "CLOSED"] as const;
export type RegisterShiftStatus = (typeof REGISTER_SHIFT_STATUSES)[number];

export type CashCount = { currency: string; amount: number };

export type RegisterPaymentSummary = {
  code: string;
  name: string;
  kind: "CASH" | "NON_CASH";
  saleCount: number;
  refundCount: number;
  sales: number;
  refunds: number;
  net: number;
};

export type RegisterCashSummary = {
  currency: string;
  openingFloat: number;
  cashSales: number;
  cashRefunds: number;
  expectedCash: number;
  countedCash?: number;
  variance?: number;
};

export type RegisterShiftSummary = {
  currency: string;
  saleCount: number;
  refundCount: number;
  grossSales: number;
  refunds: number;
  netSales: number;
  paymentBreakdown: RegisterPaymentSummary[];
  cashByCurrency: RegisterCashSummary[];
};

export type RegisterShiftRecord = {
  _id: string;
  shiftNo: string;
  counterId: string;
  counterCode: string;
  counterName: string;
  locationId: string;
  locationName: string;
  currency: string;
  activeCurrencies: string[];
  openingCash: CashCount[];
  status: RegisterShiftStatus;
  openedBy: string;
  openedByName: string;
  openedByRole: string;
  openedAt: string;
  closedBy?: string;
  closedByName?: string;
  closedAt?: string;
  closeNote?: string;
  reviewedBy?: string;
  reviewedByName?: string;
  reviewedAt?: string;
  reviewNote?: string;
  summary?: RegisterShiftSummary;
  liveSummary?: RegisterShiftSummary;
};

const cashCountItemSchema = z.object({
  currency: currencyCodeSchema,
  amount: z.coerce.number().finite().min(0).max(100_000_000),
}).strict();

export const cashCountsSchema = z.array(cashCountItemSchema).min(1).max(12).superRefine((values, context) => {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.currency)) context.addIssue({ code: "custom", path: [index, "currency"], message: "Each currency can appear only once." });
    seen.add(value.currency);
  }
});

export const registerShiftOpenSchema = z.object({
  counterId: z.string().regex(/^[a-f\d]{24}$/i),
  clientRequestId: z.string().uuid(),
  openingCash: cashCountsSchema,
}).strict();

export const registerShiftActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CLOSE"),
    id: z.string().regex(/^[a-f\d]{24}$/i),
    clientRequestId: z.string().uuid(),
    countedCash: cashCountsSchema,
    note: z.string().trim().max(300).default(""),
  }).strict(),
  z.object({
    action: z.literal("APPROVE"),
    id: z.string().regex(/^[a-f\d]{24}$/i),
    note: z.string().trim().min(3).max(300),
  }).strict(),
]);

export type RegisterMovement = {
  direction: "SALE" | "REFUND";
  paymentMethod: string;
  paymentMethodName: string;
  paymentKind: "CASH" | "NON_CASH";
  baseAmount: number;
  currency: string;
  currencyAmount: number;
  count: number;
};

function countMap(values: CashCount[]) {
  return new Map(values.map((entry) => [entry.currency, entry.amount]));
}

export function normaliseCashCounts(values: CashCount[]) {
  return values.map((entry) => ({ currency: entry.currency, amount: roundCurrency(entry.amount, entry.currency) }));
}

export function summariseRegisterShift(input: {
  currency: string;
  openingCash: CashCount[];
  movements: RegisterMovement[];
  countedCash?: CashCount[];
}): RegisterShiftSummary {
  const opening = countMap(normaliseCashCounts(input.openingCash));
  const counted = input.countedCash ? countMap(normaliseCashCounts(input.countedCash)) : null;
  const cashSales = new Map<string, number>();
  const cashRefunds = new Map<string, number>();
  const payments = new Map<string, RegisterPaymentSummary>();
  let saleCount = 0;
  let refundCount = 0;
  let grossSales = 0;
  let refunds = 0;

  for (const movement of input.movements) {
    const baseAmount = roundCurrency(movement.baseAmount, input.currency);
    const currencyAmount = roundCurrency(movement.currencyAmount, movement.currency);
    const count = Math.max(0, Math.trunc(movement.count));
    const key = `${movement.paymentMethod}\u0000${movement.paymentKind}`;
    const payment = payments.get(key) || {
      code: movement.paymentMethod,
      name: movement.paymentMethodName,
      kind: movement.paymentKind,
      saleCount: 0,
      refundCount: 0,
      sales: 0,
      refunds: 0,
      net: 0,
    };
    if (movement.direction === "SALE") {
      saleCount += count;
      grossSales = roundCurrency(grossSales + baseAmount, input.currency);
      payment.saleCount += count;
      payment.sales = roundCurrency(payment.sales + baseAmount, input.currency);
      if (movement.paymentKind === "CASH") cashSales.set(movement.currency, roundCurrency((cashSales.get(movement.currency) || 0) + currencyAmount, movement.currency));
    } else {
      refundCount += count;
      refunds = roundCurrency(refunds + baseAmount, input.currency);
      payment.refundCount += count;
      payment.refunds = roundCurrency(payment.refunds + baseAmount, input.currency);
      if (movement.paymentKind === "CASH") cashRefunds.set(movement.currency, roundCurrency((cashRefunds.get(movement.currency) || 0) + currencyAmount, movement.currency));
    }
    payment.net = roundCurrency(payment.sales - payment.refunds, input.currency);
    payments.set(key, payment);
  }

  const currencies = new Set([...opening.keys(), ...(counted?.keys() || []), ...cashSales.keys(), ...cashRefunds.keys()]);
  const orderedCurrencies = [...currencies].sort((left, right) => left === input.currency ? -1 : right === input.currency ? 1 : left.localeCompare(right));
  return {
    currency: input.currency,
    saleCount,
    refundCount,
    grossSales,
    refunds,
    netSales: roundCurrency(grossSales - refunds, input.currency),
    paymentBreakdown: [...payments.values()].sort((left, right) => left.name.localeCompare(right.name)),
    cashByCurrency: orderedCurrencies.map((currency) => {
      const openingFloat = roundCurrency(opening.get(currency) || 0, currency);
      const sales = roundCurrency(cashSales.get(currency) || 0, currency);
      const returned = roundCurrency(cashRefunds.get(currency) || 0, currency);
      const expectedCash = roundCurrency(openingFloat + sales - returned, currency);
      if (!counted) return { currency, openingFloat, cashSales: sales, cashRefunds: returned, expectedCash };
      const countedCash = roundCurrency(counted.get(currency) || 0, currency);
      return { currency, openingFloat, cashSales: sales, cashRefunds: returned, expectedCash, countedCash, variance: roundCurrency(countedCash - expectedCash, currency) };
    }),
  };
}

export function registerSummaryNeedsReview(summary: RegisterShiftSummary) {
  return summary.cashByCurrency.some((entry) => entry.variance !== undefined && currencyMinorUnits(entry.variance, entry.currency) !== 0);
}

export async function calculateRegisterShiftSummary(
  db: Db,
  shift: { _id: ObjectId; currency: string; openingCash: CashCount[] },
  countedCash?: CashCount[],
  session?: ClientSession,
) {
  const aggregateOptions = session ? { session } : undefined;
  const [sales, refunds] = await Promise.all([
    db.collection("sales").aggregate([
      { $match: { shiftId: shift._id } },
      { $group: {
        _id: {
          paymentMethod: "$paymentMethod",
          paymentMethodName: { $ifNull: ["$paymentMethodName", "$paymentMethod"] },
          paymentKind: { $ifNull: ["$paymentKind", "NON_CASH"] },
          currency: { $ifNull: ["$tenderCurrency", "$currency"] },
        },
        baseAmount: { $sum: "$total" },
        currencyAmount: { $sum: { $ifNull: ["$tenderTotal", "$total"] } },
        count: { $sum: 1 },
      } },
    ], aggregateOptions).toArray(),
    db.collection("refunds").aggregate([
      { $match: { shiftId: shift._id } },
      { $group: {
        _id: {
          paymentMethod: "$paymentMethod",
          paymentMethodName: { $ifNull: ["$paymentMethodName", "$paymentMethod"] },
          paymentKind: { $ifNull: ["$paymentKind", "NON_CASH"] },
          currency: { $ifNull: ["$tenderCurrency", "$currency"] },
        },
        baseAmount: { $sum: "$total" },
        currencyAmount: { $sum: { $ifNull: ["$tenderTotal", "$total"] } },
        count: { $sum: 1 },
      } },
    ], aggregateOptions).toArray(),
  ]);
  const movements: RegisterMovement[] = [...sales.map((row) => ({
    direction: "SALE" as const,
    paymentMethod: String(row._id.paymentMethod || "UNKNOWN"),
    paymentMethodName: String(row._id.paymentMethodName || row._id.paymentMethod || "Unknown"),
    paymentKind: row._id.paymentKind === "CASH" ? "CASH" as const : "NON_CASH" as const,
    baseAmount: Number(row.baseAmount || 0),
    currency: String(row._id.currency || shift.currency),
    currencyAmount: Number(row.currencyAmount || 0),
    count: Number(row.count || 0),
  })), ...refunds.map((row) => ({
    direction: "REFUND" as const,
    paymentMethod: String(row._id.paymentMethod || "UNKNOWN"),
    paymentMethodName: String(row._id.paymentMethodName || row._id.paymentMethod || "Unknown"),
    paymentKind: row._id.paymentKind === "CASH" ? "CASH" as const : "NON_CASH" as const,
    baseAmount: Number(row.baseAmount || 0),
    currency: String(row._id.currency || shift.currency),
    currencyAmount: Number(row.currencyAmount || 0),
    count: Number(row.count || 0),
  }))];
  return summariseRegisterShift({ currency: shift.currency, openingCash: shift.openingCash, movements, countedCash });
}
