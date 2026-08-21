import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { asMoney, serialise } from "@/lib/format";

export const runtime = "nodejs";

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
    const includeArchived = url.searchParams.get("includeArchived") === "1" && ["OWNER", "ADMIN", "MANAGER"].includes(auth.session.role);
    const filter: Record<string, unknown> = includeArchived ? {} : { active: { $ne: false } };
    if (barcode) filter.barcode = normaliseBarcode(barcode);
    const products = await db.collection("products").find(filter).sort({ active: -1, category: 1, name: 1 }).limit(500).toArray();
    return ok(serialise(products));
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
    const now = new Date();
    const { barcode, ...productData } = input.data;
    const document = {
      ...productData,
      sku: input.data.sku.toUpperCase(),
      ...(barcode ? { barcode: normaliseBarcode(barcode) } : {}),
      price: asMoney(input.data.price),
      cost: asMoney(input.data.cost),
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
      const { id, restore, barcode, ...changes } = update.data;
      const set = {
        ...changes,
        ...(changes.sku ? { sku: changes.sku.toUpperCase() } : {}),
        ...(barcode ? { barcode: normaliseBarcode(barcode) } : {}),
        ...(changes.price !== undefined ? { price: asMoney(changes.price) } : {}),
        ...(changes.cost !== undefined ? { cost: asMoney(changes.cost) } : {}),
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
    const product = await db.collection("products").findOneAndUpdate(
      { _id, active: { $ne: false }, $expr: { $gte: [{ $add: ["$stock", input.data.adjustment] }, 0] } },
      { $inc: { stock: input.data.adjustment }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!product) return fail("Adjustment would make stock negative, or the product no longer exists.", 409);
    await db.collection("stockMovements").insertOne({
      productId: _id, sku: product.sku, productName: product.name,
      quantity: input.data.adjustment, type: "ADJUSTMENT", reason: input.data.reason,
      createdBy: new ObjectId(auth.session.id), createdAt: new Date(),
    });
    await writeAudit(db, auth.session, "inventory.adjust", "product", input.data.id, { quantity: input.data.adjustment, reason: input.data.reason });
    return ok(serialise(product));
  } catch (error) {
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
