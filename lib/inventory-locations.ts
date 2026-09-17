import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

const allocationLineSchema = z.object({
  locationId: objectIdSchema,
  quantity: z.coerce.number().int().min(0).max(10_000_000),
}).strict();

const transferLineSchema = z.object({
  productId: objectIdSchema,
  quantity: z.coerce.number().int().min(1).max(1_000_000),
}).strict();

function uniqueLines(values: Array<{ locationId?: string; productId?: string }>, key: "locationId" | "productId", context: z.RefinementCtx) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const id = String(value[key] || "");
    if (seen.has(id)) context.addIssue({ code: "custom", path: [index, key], message: `Each ${key === "locationId" ? "location" : "product"} can appear only once.` });
    seen.add(id);
  });
}

export const stockTransferPostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ALLOCATE"),
    clientRequestId: z.string().uuid(),
    productId: objectIdSchema,
    allocations: z.array(allocationLineSchema).min(1).max(100),
  }).strict().superRefine((value, context) => uniqueLines(value.allocations, "locationId", context)),
  z.object({
    action: z.literal("DISPATCH"),
    clientRequestId: z.string().uuid(),
    sourceLocationId: objectIdSchema,
    destinationLocationId: objectIdSchema,
    note: z.string().trim().max(300).default(""),
    items: z.array(transferLineSchema).min(1).max(100),
  }).strict().superRefine((value, context) => {
    uniqueLines(value.items, "productId", context);
    if (value.sourceLocationId === value.destinationLocationId) context.addIssue({ code: "custom", path: ["destinationLocationId"], message: "Choose a different destination." });
  }),
]);

const transferActionBase = z.object({ id: objectIdSchema, version: z.coerce.number().int().min(0) });
export const stockTransferActionSchema = z.discriminatedUnion("action", [
  transferActionBase.extend({ action: z.literal("RECEIVE"), note: z.string().trim().max(300).default("") }).strict(),
  transferActionBase.extend({ action: z.literal("CANCEL"), note: z.string().trim().min(3).max(300) }).strict(),
]);

export function allocationTotal(allocations: Array<{ quantity: number }>) {
  return allocations.reduce((sum, allocation) => sum + Math.max(0, Math.trunc(Number(allocation.quantity) || 0)), 0);
}

export function transferUnitTotal(items: Array<{ quantity: number }>) {
  return items.reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.quantity) || 0)), 0);
}

export type LocationInventoryBalance = {
  _id: string;
  productId: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  sku: string;
  productName: string;
  quantity: number;
  updatedAt: string;
};

export type StockTransferRecord = {
  _id: string;
  transferNo: string;
  sourceLocationId: string;
  sourceLocationCode: string;
  sourceLocationName: string;
  destinationLocationId: string;
  destinationLocationCode: string;
  destinationLocationName: string;
  status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  note: string;
  items: Array<{ productId: string; sku: string; productName: string; unit: string; quantity: number }>;
  totalUnits: number;
  dispatchedByName: string;
  dispatchedAt: string;
  receivedByName?: string;
  receivedAt?: string;
  cancelledByName?: string;
  cancelledAt?: string;
  completionNote?: string;
  version: number;
};
