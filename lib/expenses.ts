import type { ClientSession, Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { isValidDateKey } from "@/lib/dates";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";

export const EXPENSE_CATEGORIES = ["TRAVEL", "MEALS", "SUPPLIES", "UTILITIES", "MARKETING", "MAINTENANCE", "OTHER"] as const;
const dateKeySchema = z.string().trim().refine(isValidDateKey, "Choose a valid expense date.");

export const expenseClaimInputSchema = z.object({
  clientRequestId: z.string().uuid(),
  expenseDate: dateKeySchema,
  merchant: z.string().trim().min(2).max(120),
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().trim().min(3).max(500),
  amount: z.coerce.number().positive().max(100_000_000),
  taxAmount: z.coerce.number().min(0).max(100_000_000).default(0),
  expenseAccountCode: z.string().trim().min(1).max(20),
}).superRefine((value, context) => {
  if (value.taxAmount > value.amount) context.addIssue({ code: "custom", path: ["taxAmount"], message: "Tax cannot exceed the claim total." });
});

export const expenseClaimActionSchema = z.discriminatedUnion("action", [
  z.object({ id: z.string().length(24), action: z.literal("SUBMIT") }),
  z.object({ id: z.string().length(24), action: z.literal("APPROVE"), note: z.string().trim().max(300).default("") }),
  z.object({ id: z.string().length(24), action: z.literal("REJECT"), note: z.string().trim().min(3).max(300) }),
  z.object({ id: z.string().length(24), action: z.literal("PAY"), clientRequestId: z.string().uuid(), paymentDate: dateKeySchema, paymentAccountCode: z.string().trim().min(1).max(20), reference: z.string().trim().min(2).max(100), note: z.string().trim().max(300).default("") }),
]);

export function expenseAmounts(amountValue: number, taxValue: number, currency: string) {
  const amount = roundCurrency(amountValue, currency);
  const taxAmount = roundCurrency(taxValue, currency);
  if (currencyMinorUnits(amount, currency) <= 0 || currencyMinorUnits(taxAmount, currency) < 0 || currencyMinorUnits(taxAmount, currency) > currencyMinorUnits(amount, currency)) throw new Error("Check the claim total and tax amount.");
  if (amount !== amountValue || taxAmount !== taxValue) throw new Error(`Use the supported decimal precision for ${currency}.`);
  return { amount, taxAmount, expenseAmount: roundCurrency(amount - taxAmount, currency) };
}

export const EXPENSE_FALLBACK_ACCOUNT = { code: "6100", name: "Operating expenses", type: "EXPENSE" } as const;
export async function ensureExpenseAccounts(db: Db, createdBy?: ObjectId, session?: ClientSession) {
  const now = new Date();
  await db.collection("chartOfAccounts").updateOne(
    { code: EXPENSE_FALLBACK_ACCOUNT.code },
    { $setOnInsert: { ...EXPENSE_FALLBACK_ACCOUNT, active: true, createdBy: createdBy || null, createdAt: now } },
    { upsert: true, ...(session ? { session } : {}) },
  );
}
