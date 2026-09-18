import { z } from "zod";
import { isValidDateKey } from "@/lib/dates";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid record.").transform(value => value.toLowerCase());

const dateKeySchema = z.string().trim().refine(value =>
  /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value) && isValidDateKey(value.slice(0, 10)),
"Choose a valid calendar date.").transform(value => new Date(`${value.slice(0, 10)}T00:00:00.000Z`));

const quotationFields = z.object({
  memberId: z.union([objectIdSchema, z.literal("")]).optional(),
  customerName: z.string().trim().min(2).max(120),
  customerEmail: z.union([z.string().trim().email().max(254), z.literal("")]).default(""),
  customerPhone: z.string().trim().max(40).default(""),
  customerAddress: z.string().trim().max(300).default(""),
  customerReference: z.string().trim().max(80).default(""),
  validUntil: dateKeySchema,
  notes: z.string().trim().max(500).default(""),
  items: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    quantity: z.coerce.number().positive().max(100_000),
    unitPrice: z.coerce.number().min(0).max(100_000_000),
  })).min(1).max(50),
});

export const quotationInputSchema = quotationFields.extend({
  memberId: quotationFields.shape.memberId.default(""),
  clientRequestId: z.string().uuid().optional(),
});

export const quotationEditSchema = quotationFields.extend({
  action: z.literal("EDIT_DRAFT"),
  id: objectIdSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

export const quotationActionSchema = z.object({
  action: z.enum(["MARK_SENT", "ACCEPT", "REJECT", "VOID", "CONVERT"]),
  id: objectIdSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(300).default(""),
  dueDate: dateKeySchema.optional(),
}).superRefine((value, context) => {
  if (["ACCEPT", "REJECT", "VOID"].includes(value.action) && value.note.length < 3) {
    context.addIssue({ code: "custom", path: ["note"], message: "Record a short reason or customer-confirmation note." });
  }
  if (value.action === "CONVERT" && !value.dueDate) {
    context.addIssue({ code: "custom", path: ["dueDate"], message: "Choose the new invoice due date." });
  }
});

export class QuotationWorkflowError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function assertQuotationVersion(updatedAt: unknown, expectedUpdatedAt?: string) {
  if (!expectedUpdatedAt) return;
  const current = updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
  if (!Number.isFinite(current) || current !== new Date(expectedUpdatedAt).getTime()) {
    throw new QuotationWorkflowError("This quotation changed in another session. Refresh it before trying again.");
  }
}

export function nextQuotationUpdatedAt(previous: unknown, now = new Date()) {
  const old = previous instanceof Date ? previous.getTime() : new Date(String(previous)).getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(old) ? old + 1 : 0));
}

export function quotationEffectiveStatus(status: string, validUntil: Date | string, today: string) {
  const validKey = (validUntil instanceof Date ? validUntil.toISOString() : String(validUntil)).slice(0, 10);
  return status === "SENT" && validKey < today ? "EXPIRED" : status;
}

export function assertQuotationAction(status: string, action: string, validUntil: Date | string, today: string) {
  const effective = quotationEffectiveStatus(status, validUntil, today);
  const validKey = (validUntil instanceof Date ? validUntil.toISOString() : String(validUntil)).slice(0, 10);
  if (action === "MARK_SENT" && status === "DRAFT" && validKey >= today) return;
  if (action === "ACCEPT" && status === "SENT" && effective === "SENT") return;
  if (action === "REJECT" && status === "SENT") return;
  if (action === "VOID" && ["DRAFT", "SENT", "ACCEPTED"].includes(status)) return;
  if (action === "CONVERT" && status === "ACCEPTED") return;
  if ((effective === "EXPIRED" && action === "ACCEPT") || (status === "DRAFT" && action === "MARK_SENT" && validKey < today)) {
    throw new QuotationWorkflowError("This quotation has expired. Create a revised quotation with a new validity date.");
  }
  throw new QuotationWorkflowError(`A ${status.toLowerCase()} quotation cannot perform this action.`);
}
