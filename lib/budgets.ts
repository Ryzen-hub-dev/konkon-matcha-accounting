import { z } from "zod";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";
import type { UserRole } from "@/lib/types";

export const BUDGET_ACCOUNT_TYPES = ["REVENUE", "EXPENSE"] as const;
export const BUDGET_MONTHS = 12;
export type BudgetAccountType = (typeof BUDGET_ACCOUNT_TYPES)[number];

export function canApproveBudget(role: UserRole) {
  return role === "OWNER";
}

const monthlyBudgetSchema = z.array(z.coerce.number().finite().min(0).max(1_000_000_000)).length(BUDGET_MONTHS);
const budgetLineSchema = z.object({ accountCode: z.string().trim().min(1).max(20), monthly: monthlyBudgetSchema }).strict();

export const budgetCreateSchema = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).strict();

export const budgetActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("SAVE"), id: z.string().length(24), expectedVersion: z.number().int().min(1),
    name: z.string().trim().min(3).max(100), notes: z.string().trim().max(500).default(""),
    lines: z.array(budgetLineSchema).max(500),
  }).strict().superRefine((value, context) => {
    const seen = new Set<string>();
    value.lines.forEach((line, index) => {
      if (seen.has(line.accountCode)) context.addIssue({ code: "custom", path: ["lines", index, "accountCode"], message: "Each account can appear only once." });
      seen.add(line.accountCode);
    });
  }),
  z.object({
    action: z.literal("APPROVE"), id: z.string().length(24), expectedVersion: z.number().int().min(1),
    note: z.string().trim().min(3).max(300),
  }).strict(),
]);

export function budgetActual(type: BudgetAccountType, debitValue: unknown, creditValue: unknown, currency: string) {
  const debit = Number(debitValue || 0), credit = Number(creditValue || 0);
  return roundCurrency(type === "REVENUE" ? credit - debit : debit - credit, currency);
}

export function budgetYtdMonths(year: number, today: string) {
  const currentYear = Number(today.slice(0, 4));
  if (year < currentYear) return 12;
  if (year > currentYear) return 0;
  return Math.min(12, Math.max(1, Number(today.slice(5, 7))));
}

export function validateBudgetPrecision(monthly: number[], currency: string) {
  return monthly.map((value) => {
    const rounded = roundCurrency(value, currency);
    if (currencyMinorUnits(value, currency) !== currencyMinorUnits(rounded, currency) || value !== rounded) throw new Error(`Use the supported decimal precision for ${currency}.`);
    return rounded;
  });
}

export function budgetVariance(type: BudgetAccountType, budgetValue: unknown, actualValue: unknown, currency: string) {
  const budget = roundCurrency(budgetValue, currency), actual = roundCurrency(actualValue, currency);
  const difference = roundCurrency(actual - budget, currency);
  const performance = roundCurrency(type === "REVENUE" ? difference : -difference, currency);
  return { budget, actual, difference, performance, favourable: performance >= 0 };
}
