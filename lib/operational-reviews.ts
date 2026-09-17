import { ObjectId, type ClientSession, type Db, type Document } from "mongodb";
import { z } from "zod";
import { makeDocumentNo } from "@/lib/format";

export const REVIEW_CATEGORIES = ["DISCOUNT", "REFUND", "INVENTORY", "REGISTER", "SECURITY"] as const;
export const REVIEW_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const REVIEW_STATUSES = ["OPEN", "IN_REVIEW", "RESOLVED"] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type ReviewTrigger = {
  category: ReviewCategory;
  severity: ReviewSeverity;
  ruleCode: string;
  title: string;
  summary: string;
  amount?: number;
  currency?: string;
  ratio?: number;
  unitCount?: number;
  evidence?: Record<string, unknown>;
};

export type OperationalReviewRecord = ReviewTrigger & {
  _id: string;
  reviewNo: string;
  status: ReviewStatus;
  sourceType: string;
  sourceId: string;
  sourceNo: string;
  sourceHref?: string;
  occurredAt: string;
  actorName: string;
  actorRole: string;
  assignedToName?: string;
  assignedAt?: string;
  resolvedByName?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  version: number;
  history: Array<{ action: string; note: string; actorName: string; actorRole: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
};

export const operationalReviewActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ACKNOWLEDGE"),
    id: z.string().regex(/^[a-f\d]{24}$/i),
    version: z.coerce.number().int().min(0),
    note: z.string().trim().max(300).default(""),
  }).strict(),
  z.object({
    action: z.enum(["RESOLVE", "REOPEN"]),
    id: z.string().regex(/^[a-f\d]{24}$/i),
    version: z.coerce.number().int().min(0),
    note: z.string().trim().min(3).max(300),
  }).strict(),
]);

function ratio(part: number, whole: number) {
  return whole > 0 ? Math.max(0, part) / whole : 0;
}

export function assessManualDiscount(input: { subtotal: number; manualDiscount: number }): ReviewTrigger | null {
  const discountRatio = ratio(input.manualDiscount, input.subtotal);
  if (input.manualDiscount <= 0 || discountRatio < 0.1) return null;
  const percent = Math.round(discountRatio * 1000) / 10;
  return {
    category: "DISCOUNT",
    severity: discountRatio >= 0.25 ? "HIGH" : "MEDIUM",
    ruleCode: "MANUAL_DISCOUNT_RATIO",
    title: "Unusual manual discount",
    summary: `A manual discount reduced the sale by ${percent}% of its subtotal.`,
    amount: input.manualDiscount,
    ratio: discountRatio,
    evidence: { subtotal: input.subtotal, manualDiscount: input.manualDiscount, discountPercent: percent },
  };
}

export function assessRefund(input: { saleTotal: number; refundTotal: number; cumulativeRefundTotal: number }): ReviewTrigger | null {
  const refundRatio = ratio(input.cumulativeRefundTotal, input.saleTotal);
  if (input.refundTotal <= 0 || refundRatio < 0.5) return null;
  const percent = Math.round(refundRatio * 1000) / 10;
  return {
    category: "REFUND",
    severity: refundRatio >= 0.9 ? "HIGH" : "MEDIUM",
    ruleCode: "CUMULATIVE_REFUND_RATIO",
    title: "High-value refund",
    summary: `Refunds now cover ${percent}% of the original receipt total.`,
    amount: input.refundTotal,
    ratio: refundRatio,
    evidence: { saleTotal: input.saleTotal, refundTotal: input.refundTotal, cumulativeRefundTotal: input.cumulativeRefundTotal, refundPercent: percent },
  };
}

export function assessInventoryAdjustment(input: { currentStock: number; adjustment: number }): ReviewTrigger | null {
  if (input.adjustment >= 0) return null;
  const unitsLost = Math.abs(input.adjustment);
  const lossRatio = ratio(unitsLost, input.currentStock);
  if (unitsLost < 5 && lossRatio < 0.1) return null;
  const percent = Math.round(lossRatio * 1000) / 10;
  return {
    category: "INVENTORY",
    severity: unitsLost >= 20 || lossRatio >= 0.25 ? "HIGH" : "MEDIUM",
    ruleCode: "NEGATIVE_STOCK_ADJUSTMENT",
    title: "Unusual negative stock adjustment",
    summary: `${unitsLost} units were removed outside a sale or posted stocktake.`,
    ratio: lossRatio,
    unitCount: unitsLost,
    evidence: { stockBefore: input.currentStock, adjustment: input.adjustment, lossPercent: percent },
  };
}

export function assessStocktakeShrinkage(lines: Array<{ bookStock: number; difference: number }>): ReviewTrigger | null {
  const losses = lines.filter((line) => line.difference < 0);
  const unitsLost = losses.reduce((sum, line) => sum + Math.abs(line.difference), 0);
  const largestRatio = losses.reduce((largest, line) => Math.max(largest, ratio(Math.abs(line.difference), line.bookStock)), 0);
  if (unitsLost < 5 && largestRatio < 0.1) return null;
  const percent = Math.round(largestRatio * 1000) / 10;
  return {
    category: "INVENTORY",
    severity: unitsLost >= 20 || largestRatio >= 0.25 ? "HIGH" : "MEDIUM",
    ruleCode: "STOCKTAKE_SHRINKAGE",
    title: "Stocktake shrinkage requires review",
    summary: `${unitsLost} missing units were posted across ${losses.length} product${losses.length === 1 ? "" : "s"}.`,
    ratio: largestRatio,
    unitCount: unitsLost,
    evidence: { affectedProducts: losses.length, unitsLost, largestLineLossPercent: percent },
  };
}

export function assessRegisterVariance(cashByCurrency: Array<{ currency: string; expectedCash: number; variance?: number }>): ReviewTrigger | null {
  const variances = cashByCurrency.filter((entry) => Number(entry.variance || 0) !== 0);
  if (!variances.length) return null;
  const largestRatio = variances.reduce((largest, entry) => Math.max(largest, ratio(Math.abs(Number(entry.variance || 0)), Math.abs(entry.expectedCash))), 0);
  return {
    category: "REGISTER",
    severity: largestRatio >= 0.05 ? "HIGH" : "MEDIUM",
    ruleCode: "REGISTER_CASH_VARIANCE",
    title: "Register cash variance",
    summary: `The blind count differed from expected cash in ${variances.length} currenc${variances.length === 1 ? "y" : "ies"}.`,
    ratio: largestRatio,
    evidence: { variances },
  };
}

export function repeatedLoginFailureReview(attemptCount: number): ReviewTrigger | null {
  if (attemptCount < 5) return null;
  return {
    category: "SECURITY",
    severity: "HIGH",
    ruleCode: "REPEATED_LOGIN_FAILURE",
    title: "Repeated failed sign-in attempts",
    summary: `${attemptCount} failed sign-in attempts triggered a temporary block.`,
    evidence: { attemptCount, rawIdentityAndNetworkDataStored: false },
  };
}

type ReviewContext = {
  sourceType: string;
  sourceId: string;
  sourceNo: string;
  sourceHref?: string;
  occurredAt?: Date;
  actor?: { id?: string; fullName?: string; role?: string };
  currency?: string;
};

function withoutUndefined(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export async function writeOperationalReview(
  db: Db,
  trigger: ReviewTrigger | null,
  context: ReviewContext,
  session?: ClientSession,
) {
  if (!trigger) return;
  const now = context.occurredAt || new Date();
  const severityRank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[trigger.severity];
  const document = withoutUndefined({
    _id: new ObjectId(),
    reviewNo: makeDocumentNo("REV"),
    ...trigger,
    severityRank,
    currency: trigger.currency || context.currency,
    status: "OPEN",
    sourceType: context.sourceType,
    sourceId: context.sourceId,
    sourceNo: context.sourceNo,
    sourceHref: context.sourceHref,
    occurredAt: now,
    actorId: context.actor?.id && ObjectId.isValid(context.actor.id) ? new ObjectId(context.actor.id) : undefined,
    actorName: context.actor?.fullName || "Unknown sign-in client",
    actorRole: context.actor?.role || "UNAUTHENTICATED",
    version: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("operationalReviews").updateOne(
    { sourceType: context.sourceType, sourceId: context.sourceId, ruleCode: trigger.ruleCode },
    { $setOnInsert: document },
    { upsert: true, ...(session ? { session } : {}) },
  );
}

export async function resolveLinkedOperationalReview(
  db: Db,
  sourceType: string,
  sourceId: string,
  actor: { id: string; fullName: string; role: string },
  note: string,
  session?: ClientSession,
) {
  const now = new Date();
  const actorId = new ObjectId(actor.id);
  const update: Document = {
    $set: { status: "RESOLVED", resolvedBy: actorId, resolvedByName: actor.fullName, resolvedAt: now, resolutionNote: note, updatedAt: now },
    $inc: { version: 1 },
    $push: { history: { action: "RESOLVE", note, actorId, actorName: actor.fullName, actorRole: actor.role, createdAt: now } },
  };
  await db.collection("operationalReviews").updateOne(
    { sourceType, sourceId, status: { $in: ["OPEN", "IN_REVIEW"] } },
    update,
    session ? { session } : undefined,
  );
}
