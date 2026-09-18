import { z } from "zod";
import { isValidDateKey } from "@/lib/dates";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid record.").transform(value => value.toLowerCase());

const dateKeySchema = z.string().trim().refine(value =>
  /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value) && isValidDateKey(value.slice(0, 10)),
"Choose a valid calendar date.").transform(value => new Date(`${value.slice(0, 10)}T00:00:00.000Z`));

export const deliveryOrderInputSchema = z.object({
  sourceQuoteId: objectIdSchema,
  scheduledDate: dateKeySchema,
  clientRequestId: z.string().uuid().optional(),
});

export const deliveryOrderEditSchema = z.object({
  action: z.literal("EDIT_DRAFT"),
  id: objectIdSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  scheduledDate: dateKeySchema,
  deliveryAddress: z.string().trim().max(300).default(""),
  contactName: z.string().trim().max(120).default(""),
  contactPhone: z.string().trim().max(40).default(""),
  carrier: z.string().trim().max(80).default(""),
  trackingReference: z.string().trim().max(100).default(""),
  instructions: z.string().trim().max(500).default(""),
});

export const deliveryOrderActionSchema = z.object({
  action: z.enum(["DISPATCH", "DELIVER", "CANCEL"]),
  id: objectIdSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(300).default(""),
  receivedBy: z.string().trim().max(120).default(""),
}).superRefine((value, context) => {
  if (value.note.length < 3) {
    context.addIssue({ code: "custom", path: ["note"], message: "Record a short operational note or reason." });
  }
  if (value.action === "DELIVER" && value.receivedBy.length < 2) {
    context.addIssue({ code: "custom", path: ["receivedBy"], message: "Record who the operator says received the delivery." });
  }
});

export class DeliveryOrderWorkflowError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function assertDeliveryOrderVersion(updatedAt: unknown, expectedUpdatedAt: string) {
  const current = updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
  if (!Number.isFinite(current) || current !== new Date(expectedUpdatedAt).getTime()) {
    throw new DeliveryOrderWorkflowError("This delivery order changed in another session. Refresh it before trying again.");
  }
}

export function nextDeliveryOrderUpdatedAt(previous: unknown, now = new Date()) {
  const old = previous instanceof Date ? previous.getTime() : new Date(String(previous)).getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(old) ? old + 1 : 0));
}

export function deliveryOrderEffectiveStatus(status: string, scheduledDate: Date | string, today: string) {
  const scheduledKey = (scheduledDate instanceof Date ? scheduledDate.toISOString() : String(scheduledDate)).slice(0, 10);
  return ["DRAFT", "DISPATCHED"].includes(status) && scheduledKey < today ? "OVERDUE" : status;
}

export function assertDeliveryOrderAction(order: { status: unknown; deliveryAddress?: unknown; contactName?: unknown }, action: string) {
  const status = String(order.status);
  if (action === "DISPATCH" && status === "DRAFT") {
    if (String(order.deliveryAddress || "").trim().length < 5) {
      throw new DeliveryOrderWorkflowError("Add a delivery address before dispatching this order.", 422);
    }
    if (String(order.contactName || "").trim().length < 2) {
      throw new DeliveryOrderWorkflowError("Add a delivery contact before dispatching this order.", 422);
    }
    return;
  }
  if (action === "DELIVER" && status === "DISPATCHED") return;
  if (action === "CANCEL" && ["DRAFT", "DISPATCHED"].includes(status)) return;
  throw new DeliveryOrderWorkflowError(`A ${status.toLowerCase()} delivery order cannot perform this action.`);
}
