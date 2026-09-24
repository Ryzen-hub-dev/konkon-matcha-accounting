import { createHash } from "node:crypto";
import { z } from "zod";
import { isValidDateKey, shiftDateKey } from "@/lib/dates";
import { documentDimensionSelectionSchema } from "@/lib/dimension-selection";

export const recurringFrequencies = ["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const;
export type RecurringFrequency = (typeof recurringFrequencies)[number];

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid reference.").transform(value => value.toLowerCase());
const dateKeySchema = z.string().trim().refine(isValidDateKey, "Choose a valid calendar date.");

export const recurringInvoiceInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  memberId: objectIdSchema,
  billingAddress: z.string().trim().max(300).default(""),
  customerReference: z.string().trim().max(80).default(""),
  notes: z.string().trim().max(500).default(""),
  templateId: z.union([objectIdSchema, z.literal("")]).default(""),
  dimensionSelection: documentDimensionSelectionSchema,
  items: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    quantity: z.coerce.number().positive().max(100_000),
    unitPrice: z.coerce.number().min(0).max(100_000_000),
  })).min(1).max(50),
  frequency: z.enum(recurringFrequencies),
  startDate: dateKeySchema,
  endDate: z.union([dateKeySchema, z.literal("")]).default(""),
  dueDays: z.coerce.number().int().min(0).max(365).default(14),
  clientRequestId: z.string().uuid(),
}).superRefine((value, context) => {
  if (value.endDate && value.endDate < value.startDate) {
    context.addIssue({ code: "custom", path: ["endDate"], message: "The end date cannot be earlier than the start date." });
  }
});

export const recurringInvoiceActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("RUN_DUE") }),
  z.object({
    action: z.enum(["PAUSE", "RESUME", "END"]),
    id: objectIdSchema,
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  }),
]);

export class RecurringInvoiceError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

function daysInUtcMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function advanceRecurringDate(
  value: string,
  frequency: RecurringFrequency,
  anchorDay = Number(value.slice(8, 10)),
) {
  if (!isValidDateKey(value)) throw new RecurringInvoiceError("The recurring date is invalid.", 422);
  if (frequency === "WEEKLY") return shiftDateKey(value, 7);
  const year = Number(value.slice(0, 4));
  const monthIndex = Number(value.slice(5, 7)) - 1;
  const months = frequency === "MONTHLY" ? 1 : frequency === "QUARTERLY" ? 3 : 12;
  const targetIndex = year * 12 + monthIndex + months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonthIndex = targetIndex % 12;
  const targetDay = Math.min(anchorDay, daysInUtcMonth(targetYear, targetMonthIndex + 1));
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

export function recurringDueDate(occurrenceDate: string, dueDays: number) {
  if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) throw new RecurringInvoiceError("The payment term is invalid.", 422);
  return shiftDateKey(occurrenceDate, dueDays);
}

export function recurringOccurrenceRequestId(scheduleId: string, occurrenceDate: string) {
  if (!/^[a-fA-F0-9]{24}$/.test(scheduleId) || !isValidDateKey(occurrenceDate)) {
    throw new RecurringInvoiceError("The recurring occurrence reference is invalid.", 422);
  }
  const hex = createHash("sha256").update(`${scheduleId.toLowerCase()}:${occurrenceDate}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function recurringScheduleObjectId(clientRequestId: string) {
  return createHash("sha256").update(`recurring-schedule:${clientRequestId.toLowerCase()}`).digest("hex").slice(0, 24);
}

export function assertRecurringInvoiceVersion(updatedAt: unknown, expectedUpdatedAt: string) {
  const actual = updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
  const expected = new Date(expectedUpdatedAt).getTime();
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || actual !== expected) {
    throw new RecurringInvoiceError("This schedule changed in another session. Refresh before trying again.");
  }
}

export function assertRecurringInvoiceAction(status: unknown, action: "PAUSE" | "RESUME" | "END") {
  if (action === "END") {
    if (["ENDED", "COMPLETED"].includes(String(status))) throw new RecurringInvoiceError("This schedule has already ended.");
    return;
  }
  if (action === "PAUSE" && status !== "ACTIVE") throw new RecurringInvoiceError("Only an active schedule can be paused.");
  if (action === "RESUME" && status !== "PAUSED") throw new RecurringInvoiceError("Only a paused schedule can be resumed.");
}
