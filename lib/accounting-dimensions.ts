import { z } from "zod";
import { roundCurrency } from "@/lib/international";

export const DIMENSION_TYPES = ["COST_CENTRE", "PROJECT"] as const;
export type AccountingDimensionType = (typeof DIMENSION_TYPES)[number];

const dimensionCodeSchema = z.string().trim().transform(value => value.toUpperCase()).pipe(
  z.string().min(2).max(20).regex(/^[A-Z0-9][A-Z0-9_-]*$/, "Use letters, numbers, dashes or underscores."),
);

export const dimensionCreateSchema = z.object({
  type: z.enum(DIMENSION_TYPES),
  code: dimensionCodeSchema,
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(240).default(""),
});

export const dimensionUpdateSchema = z.object({
  id: z.string().length(24),
  expectedVersion: z.coerce.number().int().min(1),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(240).default(""),
  active: z.boolean(),
});

export const journalDimensionIdSchema = z.union([z.string().trim().length(24), z.literal("")]).optional();

export type DimensionMaster = {
  type: AccountingDimensionType;
  code: string;
  name: string;
  active: boolean;
};

export type DimensionMovement = {
  code?: string;
  name?: string;
  accountCode: string;
  debit: number;
  credit: number;
  activity: number;
  lineCount: number;
};

export type DimensionReportRow = {
  code: string;
  name: string;
  active: boolean;
  assigned: boolean;
  revenue: number;
  expense: number;
  profit: number;
  activity: number;
  lineCount: number;
};

export function dimensionNormalBalance(accountType: "REVENUE" | "EXPENSE", debit: number, credit: number, currency: string) {
  return roundCurrency(accountType === "REVENUE" ? credit - debit : debit - credit, currency);
}

export function buildDimensionReport(
  type: AccountingDimensionType,
  dimensions: DimensionMaster[],
  movements: DimensionMovement[],
  accountTypes: Map<string, "REVENUE" | "EXPENSE">,
  currency: string,
) {
  const rows = new Map<string, DimensionReportRow>();
  for (const dimension of dimensions.filter(item => item.type === type && item.active)) {
    rows.set(dimension.code, { code: dimension.code, name: dimension.name, active: true, assigned: true, revenue: 0, expense: 0, profit: 0, activity: 0, lineCount: 0 });
  }
  for (const movement of movements) {
    const accountType = accountTypes.get(movement.accountCode);
    if (!accountType) continue;
    const code = movement.code || "UNASSIGNED";
    const master = dimensions.find(item => item.type === type && item.code === code);
    const row = rows.get(code) || {
      code,
      name: code === "UNASSIGNED" ? "Unassigned" : movement.name || master?.name || code,
      active: master?.active !== false,
      assigned: code !== "UNASSIGNED",
      revenue: 0,
      expense: 0,
      profit: 0,
      activity: 0,
      lineCount: 0,
    };
    const amount = dimensionNormalBalance(accountType, Number(movement.debit || 0), Number(movement.credit || 0), currency);
    if (accountType === "REVENUE") row.revenue = roundCurrency(row.revenue + amount, currency);
    else row.expense = roundCurrency(row.expense + amount, currency);
    row.activity = roundCurrency(row.activity + Number(movement.activity || 0), currency);
    row.lineCount += Number(movement.lineCount || 0);
    rows.set(code, row);
  }
  const result = [...rows.values()].map(row => ({ ...row, profit: roundCurrency(row.revenue - row.expense, currency) }))
    .sort((left, right) => Number(left.code === "UNASSIGNED") - Number(right.code === "UNASSIGNED") || right.profit - left.profit || left.code.localeCompare(right.code));
  const total = result.reduce((summary, row) => ({
    revenue: summary.revenue + row.revenue,
    expense: summary.expense + row.expense,
    activity: summary.activity + row.activity,
    unassignedActivity: summary.unassignedActivity + (row.assigned ? 0 : row.activity),
    lineCount: summary.lineCount + row.lineCount,
  }), { revenue: 0, expense: 0, activity: 0, unassignedActivity: 0, lineCount: 0 });
  const activity = roundCurrency(total.activity, currency);
  const unassignedActivity = roundCurrency(total.unassignedActivity, currency);
  return {
    rows: result,
    summary: {
      revenue: roundCurrency(total.revenue, currency),
      expense: roundCurrency(total.expense, currency),
      profit: roundCurrency(total.revenue - total.expense, currency),
      activity,
      unassignedActivity,
      assignmentRate: activity > 0 ? Math.max(0, Math.min(100, ((activity - unassignedActivity) / activity) * 100)) : 100,
      lineCount: total.lineCount,
    },
  };
}
