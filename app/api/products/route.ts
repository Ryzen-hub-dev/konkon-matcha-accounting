import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { roundCurrency } from "@/lib/international";
import { serialise } from "@/lib/format";
import { assessInventoryAdjustment, writeOperationalReview } from "@/lib/operational-reviews";
import { dateKeyInTimeZone } from "@/lib/dates";

export const runtime = "nodejs";

class InventoryAdjustmentError extends Error {}

const productSchema = z.object({
  sku: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9._-]+$/),
  barcode: z.union([z.string().trim().max(80).regex(/^[\x20-\x7E]+$/), z.literal("")]).default(""),
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(60),
  unit: z.string().trim().min(1).max(20),
  price: z.coerce.number().min(0).max(1_000_000),
  cost: z.coerce.number().min(0).max(1_000_000),
  stock: z.coerce.number().int().min(0).max(10_000_000),
  reorderLevel: z.coerce.number().int().min(0).max(1_000_000),
});

const adjustmentSchema = z.object({
  id: z.string().length(24),
  locationId: z.union([z.string().length(24), z.literal("")]).optional(),
  adjustment: z.coerce.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0),
  reason: z.string().trim().min(3).max(160),
});

const productUpdateSchema = z.object({
  id: z.string().length(24),
  sku: productSchema.shape.sku.optional(),
  barcode: productSchema.shape.barcode.optional(),
  name: productSchema.shape.name.optional(),
  category: productSchema.shape.category.optional(),
  unit: productSchema.shape.unit.optional(),
  price: productSchema.shape.price.optional(),
  cost: productSchema.shape.cost.optional(),
  reorderLevel: productSchema.shape.reorderLevel.optional(),
  restore: z.boolean().optional(),
}).refine((value) => value.restore || Object.keys(value).some((key) => key !== "id"));

const deleteSchema = z.object({ id: z.string().length(24) });

function normaliseBarcode(value: string) {
  return value.trim().toUpperCase();
}

export async function GET(request: Request) {
  const auth = await authorize("inventory.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const barcode = url.searchParams.get("barcode")?.trim() || "";
    const locationId = url.searchParams.get("locationId")?.trim() || "";
    const includeBalances = url.searchParams.get("includeBalances") === "1";
    if (locationId && !ObjectId.isValid(locationId)) return fail("Choose a valid inventory location.", 422);
    const includeArchived = url.searchParams.get("includeArchived") === "1" && ["OWNER", "ADMIN", "MANAGER"].includes(auth.session.role);
    const filter: Record<string, unknown> = includeArchived ? {} : { active: { $ne: false } };
    if (barcode) filter.barcode = normaliseBarcode(barcode);
    const products = await db.collection("products").find(filter).sort({ active: -1, category: 1, name: 1 }).limit(500).toArray();
    if (!products.length) return ok([]);
    if (locationId) {
      const location = await db.collection("locations").findOne({ _id: new ObjectId(locationId), active: { $ne: false } }, { projection: { _id: 1 } });
      if (!location) return fail("The selected inventory location is inactive.", 409);
    }
    const productIds = products.map((product) => product._id);
    const [balances, settings] = await Promise.all([
      db.collection("inventoryBalances").find({ productId: { $in: productIds } }).toArray(),
      locationId && products.some((product) => product.batchTracked) ? db.collection("settings").findOne({ key: "business" }) : Promise.resolve(null),
    ]);
    const sellableBatchStock = new Map<string, number>();
    if (locationId && products.some((product) => product.batchTracked)) {
      const business = normaliseBusinessSettings(settings);
      const rows = await db.collection("inventoryBatches").aggregate([
        { $match: { productId: { $in: products.filter((product) => product.batchTracked).map((product) => product._id) }, locationId: new ObjectId(locationId), expiryDate: { $gte: dateKeyInTimeZone(new Date(), business.timeZone) }, quantity: { $gt: 0 } } },
        { $group: { _id: "$productId", quantity: { $sum: "$quantity" } } },
      ]).toArray();
      for (const row of rows) sellableBatchStock.set(String(row._id), Number(row.quantity || 0));
    }
    const balancesByProduct = new Map<string, typeof balances>();
    for (const balance of balances) {
      const key = String(balance.productId);
      const current = balancesByProduct.get(key) || [];
      current.push(balance);
      balancesByProduct.set(key, current);
    }
    return ok(serialise(products.map((product) => {
      const productBalances = balancesByProduct.get(String(product._id)) || [];
      const locationBalance = locationId ? productBalances.find((balance) => String(balance.locationId) === locationId) : null;
      return {
        ...product,
        globalStock: Number(product.stock || 0),
        locationTracked: productBalances.length > 0,
        ...(locationId && productBalances.length ? { stock: product.batchTracked ? Number(sellableBatchStock.get(String(product._id)) || 0) : Number(locationBalance?.quantity || 0), stockLocationId: locationId } : {}),
        ...(includeBalances ? { locationBalances: productBalances } : {}),
      };
    })));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("inventory.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = productSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the product details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const money = (value: unknown) => roundCurrency(value, business.currency);
    const now = new Date();
    const { barcode, ...productData } = input.data;
    const document = {
      ...productData,
      sku: input.data.sku.toUpperCase(),
      ...(barcode ? { barcode: normaliseBarcode(barcode) } : {}),
      price: money(input.data.price),
      cost: money(input.data.cost),
      active: true,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("products").insertOne(document);
    await db.collection("stockMovements").insertOne({
      productId: result.insertedId, sku: document.sku, productName: document.name,
      quantity: document.stock, type: "OPENING", reason: "Opening balance",
      createdBy: new ObjectId(auth.session.id), createdAt: now,
    });
    await writeAudit(db, auth.session, "product.create", "product", result.insertedId.toHexString(), { sku: document.sku });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("A product with this SKU or barcode already exists.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("inventory.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await request.json();
    const adjustment = adjustmentSchema.safeParse(body);
    if (!adjustment.success) {
      const update = productUpdateSchema.safeParse(body);
      if (!update.success || !ObjectId.isValid(update.data?.id || "")) return fail("Check the product update.", 422, update.success ? undefined : update.error.flatten().fieldErrors);
      const db = await getDb();
      const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
      const money = (value: unknown) => roundCurrency(value, business.currency);
      const { id, restore, barcode, ...changes } = update.data;
      const set = {
        ...changes,
        ...(changes.sku ? { sku: changes.sku.toUpperCase() } : {}),
        ...(barcode ? { barcode: normaliseBarcode(barcode) } : {}),
        ...(changes.price !== undefined ? { price: money(changes.price) } : {}),
        ...(changes.cost !== undefined ? { cost: money(changes.cost) } : {}),
        ...(restore ? { active: true } : {}),
        updatedAt: new Date(),
      };
      const unset = barcode === "" ? { barcode: "", archivedAt: restore ? "" : undefined, archivedBy: restore ? "" : undefined } : { archivedAt: restore ? "" : undefined, archivedBy: restore ? "" : undefined };
      const cleanUnset = Object.fromEntries(Object.entries(unset).filter(([, value]) => value !== undefined));
      const product = await db.collection("products").findOneAndUpdate(
        { _id: new ObjectId(id), ...(restore ? { active: false } : { active: { $ne: false } }) },
        { $set: set, ...(Object.keys(cleanUnset).length ? { $unset: cleanUnset } : {}) },
        { returnDocument: "after" },
      );
      if (!product) return fail("The product no longer exists or is already in that state.", 404);
      await writeAudit(db, auth.session, restore ? "product.restore" : "product.update", "product", id, { fields: [...Object.keys(changes), ...(barcode !== undefined ? ["barcode"] : [])] });
      return ok(serialise(product));
    }
    const input = adjustment;
    if (!ObjectId.isValid(input.data.id)) return fail("Check the stock adjustment.", 422);
    const db = await getDb();
    const _id = new ObjectId(input.data.id);
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let product: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const current = await db.collection("products").findOne({ _id, active: { $ne: false } }, { session: mongoSession });
        if (!current) throw new InventoryAdjustmentError("The product is archived or no longer exists.");
        if (current.batchTracked) throw new InventoryAdjustmentError("Use Batch control to adjust or count this product so its lot and expiry history stays complete.");
        const tracked = await db.collection("inventoryBalances").findOne({ productId: _id }, { projection: { _id: 1 }, session: mongoSession });
        let location: Record<string, unknown> | null = null;
        let stockBefore = Number(current.stock || 0);
        if (tracked) {
          if (!input.data.locationId || !ObjectId.isValid(input.data.locationId)) throw new InventoryAdjustmentError("Choose the location for this stock adjustment.");
          location = await db.collection("locations").findOne({ _id: new ObjectId(input.data.locationId), active: { $ne: false } }, { session: mongoSession });
          if (!location) throw new InventoryAdjustmentError("The selected inventory location is inactive.");
          const now = new Date();
          await db.collection("inventoryBalances").updateOne(
            { productId: _id, locationId: location._id },
            { $setOnInsert: { _id: new ObjectId(), sku: current.sku, productName: current.name, locationCode: location.code, locationName: location.name, quantity: 0, createdBy: new ObjectId(auth.session.id), createdAt: now, updatedAt: now } },
            { upsert: true, session: mongoSession },
          );
          const balance = await db.collection("inventoryBalances").findOneAndUpdate(
            { productId: _id, locationId: location._id, $expr: { $gte: [{ $add: ["$quantity", input.data.adjustment] }, 0] } },
            { $inc: { quantity: input.data.adjustment }, $set: { updatedAt: now } },
            { returnDocument: "after", session: mongoSession },
          );
          if (!balance) throw new InventoryAdjustmentError("Adjustment would make this location's stock negative.");
          stockBefore = Number(balance.quantity) - input.data.adjustment;
        }
        product = await db.collection("products").findOneAndUpdate(
          { _id, active: { $ne: false }, $expr: { $gte: [{ $add: ["$stock", input.data.adjustment] }, 0] } },
          { $inc: { stock: input.data.adjustment }, $set: { updatedAt: new Date() } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!product) throw new InventoryAdjustmentError("Adjustment would make total stock negative, or the product changed.");
        const movementId = new ObjectId();
        const movementAt = new Date();
        await db.collection("stockMovements").insertOne({
          _id: movementId,
          productId: _id, sku: product.sku, productName: product.name,
          quantity: input.data.adjustment, type: "ADJUSTMENT", reason: input.data.reason,
          ...(location ? { locationId: location._id, locationCode: location.code, locationName: location.name } : {}),
          createdBy: new ObjectId(auth.session.id), createdAt: movementAt,
        }, { session: mongoSession });
        await writeOperationalReview(db, assessInventoryAdjustment({ currentStock: stockBefore, adjustment: input.data.adjustment }), {
          sourceType: "stockMovement",
          sourceId: movementId.toHexString(),
          sourceNo: String(product.sku),
          sourceHref: "/inventory",
          occurredAt: movementAt,
          actor: auth.session,
        }, mongoSession);
        await writeAudit(db, auth.session, "inventory.adjust", "product", input.data.id, { quantity: input.data.adjustment, reason: input.data.reason, locationId: input.data.locationId || "" }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return ok(serialise(product));
  } catch (error) {
    if (error instanceof InventoryAdjustmentError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("A product with this SKU or barcode already exists.", 409);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("inventory.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = deleteSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the product reference.", 422);
    const db = await getDb();
    const now = new Date();
    const product = await db.collection("products").findOneAndUpdate(
      { _id: new ObjectId(input.data.id), active: { $ne: false } },
      { $set: { active: false, archivedAt: now, archivedBy: new ObjectId(auth.session.id), updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!product) return fail("The product no longer exists.", 404);
    await writeAudit(db, auth.session, "product.archive", "product", input.data.id, { sku: product.sku, stockPreserved: product.stock });
    return ok({ archived: true });
  } catch (error) {
    return publicError(error);
  }
}
