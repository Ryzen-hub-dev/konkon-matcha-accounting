import type { ClientSession, Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
export const inventoryDateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.").refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a valid date.");
export const inventoryLotNoSchema = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001F\u007F]+$/, "Lot number contains unsupported characters.");

const openingSchema = z.object({
  locationId: objectIdSchema,
  lotNo: inventoryLotNoSchema,
  expiryDate: inventoryDateKeySchema,
  quantity: z.coerce.number().int().min(1).max(10_000_000),
}).strict();

export const inventoryBatchActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ACTIVATE"),
    clientRequestId: z.string().uuid(),
    productId: objectIdSchema,
    expiryWarningDays: z.coerce.number().int().min(1).max(365).default(30),
    openings: z.array(openingSchema).max(500),
  }).strict().superRefine((value, context) => {
    const seen = new Set<string>();
    value.openings.forEach((opening, index) => {
      const key = batchIdentityKey(opening.locationId, opening.lotNo, opening.expiryDate);
      if (seen.has(key)) context.addIssue({ code: "custom", path: ["openings", index], message: "Each location, lot and expiry combination can appear only once." });
      seen.add(key);
    });
  }),
  z.object({
    action: z.literal("ADD"),
    clientRequestId: z.string().uuid(),
    productId: objectIdSchema,
    locationId: objectIdSchema,
    lotNo: inventoryLotNoSchema,
    expiryDate: inventoryDateKeySchema,
    quantity: z.coerce.number().int().min(1).max(1_000_000),
    reason: z.string().trim().min(3).max(200),
  }).strict(),
  z.object({
    action: z.literal("COUNT"),
    clientRequestId: z.string().uuid(),
    batchId: objectIdSchema,
    version: z.coerce.number().int().min(0),
    countedQuantity: z.coerce.number().int().min(0).max(10_000_000),
    reason: z.string().trim().min(3).max(200),
  }).strict(),
  z.object({
    action: z.literal("DISPOSE"),
    clientRequestId: z.string().uuid(),
    batchId: objectIdSchema,
    version: z.coerce.number().int().min(0),
    quantity: z.coerce.number().int().min(1).max(1_000_000),
    disposition: z.enum(["EXPIRED", "DAMAGED", "QUALITY", "RECALL", "OTHER"]),
    reason: z.string().trim().min(3).max(240),
  }).strict(),
]);

export type InventoryBatchAllocation = {
  batchId?: ObjectId;
  lotNo: string;
  lotKey: string;
  expiryDate: string;
  quantity: number;
  supplierId?: ObjectId | null;
  supplierName?: string;
  goodsReceiptId?: ObjectId | null;
  goodsReceiptNo?: string;
};

export class BatchInventoryError extends Error {}

export async function ensureInventoryDispositionAccount(db: Db, createdBy: ObjectId, session: ClientSession) {
  await db.collection("chartOfAccounts").updateOne(
    { code: "5100" },
    { $setOnInsert: { code: "5100", name: "Inventory write-off", type: "EXPENSE", active: true, createdBy, createdAt: new Date() } },
    { upsert: true, session },
  );
}

export function normaliseLotNo(value: unknown) {
  return String(value || "").normalize("NFKC").trim();
}

export function lotKey(value: unknown) {
  return normaliseLotNo(value).toUpperCase();
}

export function batchIdentityKey(locationId: unknown, lotNo: unknown, expiryDate: unknown) {
  return `${String(locationId)}|${lotKey(lotNo)}|${String(expiryDate)}`;
}

export function openingTotalsByLocation(openings: Array<{ locationId: string; quantity: number }>) {
  const totals = new Map<string, number>();
  for (const opening of openings) totals.set(opening.locationId, (totals.get(opening.locationId) || 0) + Math.max(0, Math.trunc(Number(opening.quantity) || 0)));
  return totals;
}

export function batchExpiryStatus(expiryDate: string, today: string, warningDays: number) {
  const expiry = Date.parse(`${expiryDate}T00:00:00.000Z`);
  const start = Date.parse(`${today}T00:00:00.000Z`);
  const daysRemaining = Math.floor((expiry - start) / 86_400_000);
  return {
    daysRemaining,
    status: daysRemaining < 0 ? "EXPIRED" as const : daysRemaining <= warningDays ? "EXPIRING" as const : "HEALTHY" as const,
  };
}

export type BatchForecastInput = {
  id: string;
  productId: string;
  locationId: string;
  quantity: number;
  expiryDate: string;
};

export type LocationVelocity = { productId: string; locationId: string; units: number };

export function forecastBatchFreshness(batches: BatchForecastInput[], velocities: LocationVelocity[], today: string, lookbackDays = 30) {
  const days = Math.max(1, Math.trunc(lookbackDays));
  const velocity = new Map(velocities.map((row) => [`${row.productId}|${row.locationId}`, Math.max(0, Number(row.units) || 0) / days]));
  const velocityByProduct = new Map<string, Array<{ locationId: string; dailyDemand: number }>>();
  for (const row of velocities) {
    const current = velocityByProduct.get(row.productId) || [];
    current.push({ locationId: row.locationId, dailyDemand: Math.max(0, Number(row.units) || 0) / days });
    velocityByProduct.set(row.productId, current);
  }
  const groups = new Map<string, BatchForecastInput[]>();
  for (const batch of batches) {
    const key = `${batch.productId}|${batch.locationId}`;
    const current = groups.get(key) || [];
    current.push(batch);
    groups.set(key, current);
  }
  const forecast = new Map<string, {
    dailyDemand: number;
    projectedAtRisk: number;
    forecastRisk: "EXPIRED" | "HIGH" | "MEDIUM" | "LOW";
    predictedDepletionDate: string | null;
    suggestedLocationId: string | null;
    suggestedTransferQuantity: number;
  }>();
  for (const [key, group] of groups) {
    const [productId, locationId] = key.split("|");
    const dailyDemand = velocity.get(key) || 0;
    let earlierQuantity = 0;
    for (const batch of [...group].sort((left, right) => left.expiryDate.localeCompare(right.expiryDate) || left.id.localeCompare(right.id))) {
      const expiry = Date.parse(`${batch.expiryDate}T00:00:00.000Z`);
      const start = Date.parse(`${today}T00:00:00.000Z`);
      const daysRemaining = Math.floor((expiry - start) / 86_400_000);
      const quantity = Math.max(0, Math.trunc(Number(batch.quantity) || 0));
      const demandCapacity = daysRemaining < 0 ? 0 : Math.floor(dailyDemand * (daysRemaining + 1));
      const sellableCapacity = Math.max(0, demandCapacity - earlierQuantity);
      const projectedAtRisk = Math.max(0, quantity - sellableCapacity);
      const atRiskRatio = quantity ? projectedAtRisk / quantity : 0;
      const forecastRisk = daysRemaining < 0 ? "EXPIRED" as const : atRiskRatio >= 0.5 ? "HIGH" as const : projectedAtRisk > 0 ? "MEDIUM" as const : "LOW" as const;
      const depletionDays = dailyDemand > 0 ? Math.ceil((earlierQuantity + quantity) / dailyDemand) - 1 : null;
      const predictedDepletionDate = depletionDays === null ? null : new Date(start + depletionDays * 86_400_000).toISOString().slice(0, 10);
      const destination = (velocityByProduct.get(productId) || [])
        .filter((row) => row.locationId !== locationId)
        .sort((left, right) => right.dailyDemand - left.dailyDemand || left.locationId.localeCompare(right.locationId))[0];
      const suggestedTransferQuantity = projectedAtRisk > 0 && daysRemaining >= 0 && destination && destination.dailyDemand > dailyDemand
        ? Math.min(projectedAtRisk, Math.max(1, Math.floor((destination.dailyDemand - dailyDemand) * Math.max(1, daysRemaining + 1) / 2)))
        : 0;
      forecast.set(batch.id, {
        dailyDemand: Math.round(dailyDemand * 100) / 100,
        projectedAtRisk,
        forecastRisk,
        predictedDepletionDate,
        suggestedLocationId: suggestedTransferQuantity ? destination!.locationId : null,
        suggestedTransferQuantity,
      });
      earlierQuantity += quantity;
    }
  }
  return forecast;
}

type BatchCandidate = Record<string, unknown> & { _id?: ObjectId };

export function allocateFefo(batches: BatchCandidate[], requestedQuantity: number, today?: string) {
  let remaining = Math.max(0, Math.trunc(Number(requestedQuantity) || 0));
  const eligible = [...batches]
    .filter((batch) => Number(batch.quantity || 0) > 0 && (!today || String(batch.expiryDate) >= today))
    .sort((left, right) => String(left.expiryDate).localeCompare(String(right.expiryDate))
      || new Date(left.receivedAt as string || left.createdAt as string || 0).getTime() - new Date(right.receivedAt as string || right.createdAt as string || 0).getTime()
      || String(left._id || "").localeCompare(String(right._id || "")));
  const allocations: InventoryBatchAllocation[] = [];
  for (const batch of eligible) {
    if (!remaining) break;
    const quantity = Math.min(remaining, Math.max(0, Math.trunc(Number(batch.quantity) || 0)));
    if (!quantity) continue;
    allocations.push({
      ...(batch._id ? { batchId: batch._id } : {}),
      lotNo: normaliseLotNo(batch.lotNo),
      lotKey: lotKey(batch.lotKey || batch.lotNo),
      expiryDate: String(batch.expiryDate),
      quantity,
      ...(batch.supplierId instanceof ObjectId || batch.supplierId === null ? { supplierId: batch.supplierId } : {}),
      ...(batch.supplierName ? { supplierName: String(batch.supplierName) } : {}),
      ...(batch.goodsReceiptId instanceof ObjectId || batch.goodsReceiptId === null ? { goodsReceiptId: batch.goodsReceiptId } : {}),
      ...(batch.goodsReceiptNo ? { goodsReceiptNo: String(batch.goodsReceiptNo) } : {}),
    });
    remaining -= quantity;
  }
  return { allocations, shortage: remaining };
}

export function sliceBatchAllocations(allocations: Array<Record<string, unknown>>, alreadyReturned: number, quantity: number) {
  let skip = Math.max(0, Math.trunc(Number(alreadyReturned) || 0));
  let remaining = Math.max(0, Math.trunc(Number(quantity) || 0));
  const selected: InventoryBatchAllocation[] = [];
  for (const allocation of allocations) {
    const available = Math.max(0, Math.trunc(Number(allocation.quantity) || 0));
    if (skip >= available) { skip -= available; continue; }
    const quantityFromBatch = Math.min(remaining, available - skip);
    skip = 0;
    if (quantityFromBatch > 0) selected.push({
      ...(allocation.batchId instanceof ObjectId ? { batchId: allocation.batchId } : {}),
      lotNo: normaliseLotNo(allocation.lotNo),
      lotKey: lotKey(allocation.lotKey || allocation.lotNo),
      expiryDate: String(allocation.expiryDate),
      quantity: quantityFromBatch,
      ...(allocation.supplierId instanceof ObjectId || allocation.supplierId === null ? { supplierId: allocation.supplierId } : {}),
      ...(allocation.supplierName ? { supplierName: String(allocation.supplierName) } : {}),
      ...(allocation.goodsReceiptId instanceof ObjectId || allocation.goodsReceiptId === null ? { goodsReceiptId: allocation.goodsReceiptId } : {}),
      ...(allocation.goodsReceiptNo ? { goodsReceiptNo: String(allocation.goodsReceiptNo) } : {}),
    });
    remaining -= quantityFromBatch;
    if (!remaining) break;
  }
  return { allocations: selected, shortage: remaining };
}

export async function consumeInventoryBatches(db: Db, input: {
  productId: ObjectId;
  locationId: ObjectId;
  quantity: number;
  today: string;
  productName: string;
  now: Date;
}, session: ClientSession) {
  const batches = await db.collection("inventoryBatches").find({
    productId: input.productId,
    locationId: input.locationId,
    quantity: { $gt: 0 },
  }, { session }).sort({ expiryDate: 1, receivedAt: 1, createdAt: 1, _id: 1 }).toArray();
  const result = allocateFefo(batches, input.quantity, input.today);
  if (result.shortage) throw new BatchInventoryError(`${input.productName} does not have enough unexpired batch stock at this location.`);
  for (const allocation of result.allocations) {
    const updated = await db.collection("inventoryBatches").updateOne(
      { _id: allocation.batchId, quantity: { $gte: allocation.quantity } },
      { $inc: { quantity: -allocation.quantity, version: 1 }, $set: { updatedAt: input.now } },
      { session },
    );
    if (!updated.modifiedCount) throw new BatchInventoryError(`${input.productName} batch stock changed during posting. Refresh and try again.`);
  }
  return result.allocations;
}

export async function addInventoryBatchQuantity(db: Db, input: {
  productId: ObjectId;
  sku: string;
  productName: string;
  locationId: ObjectId;
  locationCode: string;
  locationName: string;
  allocation: Omit<InventoryBatchAllocation, "batchId"> | InventoryBatchAllocation;
  actorId: ObjectId;
  now: Date;
  receivedAt?: Date;
}, session: ClientSession) {
  const normalizedLotNo = normaliseLotNo(input.allocation.lotNo);
  const normalizedLotKey = lotKey(normalizedLotNo);
  const batchId = new ObjectId();
  await db.collection("inventoryBatches").updateOne(
    { productId: input.productId, locationId: input.locationId, lotKey: normalizedLotKey, expiryDate: input.allocation.expiryDate },
    {
      $inc: { quantity: input.allocation.quantity, version: 1 },
      $set: {
        sku: input.sku, productName: input.productName, locationCode: input.locationCode, locationName: input.locationName,
        lotNo: normalizedLotNo, updatedAt: input.now,
        ...(input.allocation.supplierId !== undefined ? { supplierId: input.allocation.supplierId } : {}),
        ...(input.allocation.supplierName ? { supplierName: input.allocation.supplierName } : {}),
        ...(input.allocation.goodsReceiptId !== undefined ? { goodsReceiptId: input.allocation.goodsReceiptId } : {}),
        ...(input.allocation.goodsReceiptNo ? { goodsReceiptNo: input.allocation.goodsReceiptNo } : {}),
      },
      $setOnInsert: { _id: batchId, productId: input.productId, locationId: input.locationId, lotKey: normalizedLotKey, expiryDate: input.allocation.expiryDate, receivedAt: input.receivedAt || input.now, createdBy: input.actorId, createdAt: input.now },
    },
    { upsert: true, session },
  );
}
