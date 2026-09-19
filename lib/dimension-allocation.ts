import { ObjectId, type ClientSession, type Db } from "mongodb";
import { z } from "zod";
import { journalDimensionIdSchema } from "@/lib/accounting-dimensions";
import { currencyFractionDigits, currencyMinorUnits } from "@/lib/international";

export const DIMENSION_RULE_SOURCES = ["POS_LOCATION", "EXPENSE_ACCOUNT", "PURCHASE_LOCATION"] as const;
export type DimensionRuleSource = (typeof DIMENSION_RULE_SOURCES)[number];

const ruleDimensions = {
  costCentreId: journalDimensionIdSchema,
  projectId: journalDimensionIdSchema,
};

const allocationSplitSchema = z.object({
  ...ruleDimensions,
  percentage: z.coerce.number().positive().max(100).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, "Use no more than two percentage decimals."),
});

function validateAllocations(value: { costCentreId?: string; projectId?: string; allocations?: Array<z.infer<typeof allocationSplitSchema>> }, context: z.RefinementCtx) {
  const allocations = value.allocations?.length ? value.allocations : [{ costCentreId: value.costCentreId, projectId: value.projectId, percentage: 100 }];
  allocations.forEach((allocation, index) => {
    if (!allocation.costCentreId && !allocation.projectId) context.addIssue({ code: "custom", path: ["allocations", index], message: "Choose a cost centre, a project, or both for every split." });
  });
  if (allocations.reduce((sum, allocation) => sum + Math.round(allocation.percentage * 100), 0) !== 10_000) context.addIssue({ code: "custom", path: ["allocations"], message: "Allocation percentages must total exactly 100%." });
  const keys = allocations.map(allocation => `${allocation.costCentreId || "-"}:${allocation.projectId || "-"}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["allocations"], message: "Each cost-centre/project split must be unique." });
}

export const dimensionRuleCreateSchema = z.object({
  source: z.enum(DIMENSION_RULE_SOURCES),
  matchKey: z.string().trim().min(2).max(24),
  ...ruleDimensions,
  allocations: z.array(allocationSplitSchema).min(1).max(10).optional(),
}).superRefine(validateAllocations);

export const dimensionRuleUpdateSchema = z.object({
  id: z.string().length(24),
  expectedVersion: z.coerce.number().int().min(1),
  active: z.boolean(),
  ...ruleDimensions,
  allocations: z.array(allocationSplitSchema).min(1).max(10).optional(),
}).superRefine(validateAllocations);

export function effectiveRuleAllocations<T extends string | ObjectId>(value: { costCentreId?: T; projectId?: T; allocations?: Array<{ costCentreId?: T; projectId?: T; percentage: number }> }) {
  return value.allocations?.length ? value.allocations : [{ costCentreId: value.costCentreId, projectId: value.projectId, percentage: 100 }];
}

export type DimensionSnapshot = { id: ObjectId; code: string; name: string };
export type ResolvedDimensionSplit = { percentage: number; costCentre?: DimensionSnapshot; project?: DimensionSnapshot };
export type ResolvedDimensionAllocation = {
  allocations?: ResolvedDimensionSplit[];
  costCentre?: DimensionSnapshot;
  project?: DimensionSnapshot;
  rule: { id: ObjectId; source: DimensionRuleSource; matchKey: string; version: number };
};
export type AllocatedJournalLine<T> = T & { costCentre?: DimensionSnapshot; project?: DimensionSnapshot; dimensionRule?: ResolvedDimensionAllocation["rule"]; dimensionSplit?: { percentage: number; index: number; count: number } };

export function normaliseDimensionRuleMatchKey(source: DimensionRuleSource, value: string) {
  const trimmed = value.trim();
  return source === "EXPENSE_ACCOUNT" ? trimmed.toUpperCase() : ObjectId.isValid(trimmed) ? new ObjectId(trimmed).toHexString() : trimmed;
}

export async function resolveDimensionAllocation(
  db: Db,
  source: DimensionRuleSource,
  matchKey: string,
  session?: ClientSession,
): Promise<ResolvedDimensionAllocation | null> {
  const rule = await db.collection("dimensionAllocationRules").findOne({ source, matchKey, active: true }, session ? { session } : undefined);
  if (!rule) return null;
  const requested = effectiveRuleAllocations(rule as { costCentreId?: ObjectId; projectId?: ObjectId; allocations?: Array<{ costCentreId?: ObjectId; projectId?: ObjectId; percentage: number }> });
  const ids = [...new Set(requested.flatMap(allocation => [allocation.costCentreId, allocation.projectId]).filter((id): id is ObjectId => id instanceof ObjectId))];
  if (!ids.length) return null;
  const dimensions = await db.collection("accountingDimensions").find({ _id: { $in: ids }, active: { $ne: false } }, session ? { session } : undefined).project({ type: 1, code: 1, name: 1 }).toArray();
  const allocations: ResolvedDimensionSplit[] = [];
  for (const request of requested) {
    const costCentre = request.costCentreId ? dimensions.find(dimension => dimension.type === "COST_CENTRE" && String(dimension._id) === String(request.costCentreId)) : null;
    const project = request.projectId ? dimensions.find(dimension => dimension.type === "PROJECT" && String(dimension._id) === String(request.projectId)) : null;
    if ((request.costCentreId && !costCentre) || (request.projectId && !project) || (!costCentre && !project)) return null;
    allocations.push({
      percentage: Number(request.percentage),
      ...(costCentre ? { costCentre: { id: costCentre._id, code: String(costCentre.code), name: String(costCentre.name) } } : {}),
      ...(project ? { project: { id: project._id, code: String(project.code), name: String(project.name) } } : {}),
    });
  }
  return {
    allocations,
    ...(allocations.length === 1 ? { costCentre: allocations[0].costCentre, project: allocations[0].project } : {}),
    rule: { id: rule._id, source, matchKey, version: Number(rule.version || 1) },
  };
}

function resolvedSplits(allocation: ResolvedDimensionAllocation) {
  return allocation.allocations?.length ? allocation.allocations : [{ percentage: 100, costCentre: allocation.costCentre, project: allocation.project }];
}

function allocateMinorUnits(total: number, weights: number[]) {
  if (!total) return weights.map(() => 0);
  const weightTotal = weights.reduce((sum, weight) => sum + BigInt(weight), BigInt(0));
  const parts = weights.map((weight, index) => ({ index, value: Number(BigInt(total) * BigInt(weight) / weightTotal), remainder: BigInt(total) * BigInt(weight) % weightTotal }));
  const remaining = total - parts.reduce((sum, part) => sum + part.value, 0);
  const priority = [...parts].sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < remaining; index++) priority[index].value++;
  return parts.map(part => part.value);
}

export function applyDimensionAllocation<T extends Record<string, unknown>>(lines: T[], allocation: ResolvedDimensionAllocation | null | undefined, currency?: string): AllocatedJournalLine<T>[] {
  if (!allocation) return lines;
  const splits = resolvedSplits(allocation);
  if (splits.length === 1) return lines.map(line => ({ ...line, ...(splits[0].costCentre ? { costCentre: splits[0].costCentre } : {}), ...(splits[0].project ? { project: splits[0].project } : {}), dimensionRule: allocation.rule, dimensionSplit: { percentage: splits[0].percentage, index: 1, count: 1 } }));
  if (!currency) throw new Error("Currency is required for percentage dimension allocation.");
  const scale = 10 ** currencyFractionDigits(currency);
  const weights = splits.map(split => Math.round(split.percentage * 100));
  return lines.flatMap(line => {
    const debits = allocateMinorUnits(currencyMinorUnits(line.debit, currency), weights);
    const credits = allocateMinorUnits(currencyMinorUnits(line.credit, currency), weights);
    return splits.map((split, index) => ({
      ...line,
      debit: debits[index] / scale,
      credit: credits[index] / scale,
      ...(split.costCentre ? { costCentre: split.costCentre } : {}),
      ...(split.project ? { project: split.project } : {}),
      dimensionRule: allocation.rule,
      dimensionSplit: { percentage: split.percentage, index: index + 1, count: splits.length },
    })).filter(linePart => Number(linePart.debit || 0) > 0 || Number(linePart.credit || 0) > 0);
  });
}

export function dimensionRuleAuditId(allocation: ResolvedDimensionAllocation | null | undefined) {
  return allocation ? String(allocation.rule.id) : "";
}
