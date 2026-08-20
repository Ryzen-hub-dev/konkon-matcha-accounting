import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { asMoney, serialise } from "@/lib/format";

export const runtime = "nodejs";

const productSchema = z.object({
  sku: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9._-]+$/),
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

export async function GET() {
  const auth = await authorize("inventory.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const products = await db.collection("products").find({ active: { $ne: false } }).sort({ category: 1, name: 1 }).limit(500).toArray();
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
    const document = {
      ...input.data,
      sku: input.data.sku.toUpperCase(),
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
    if ((error as { code?: number }).code === 11000) return fail("A product with this SKU already exists.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("inventory.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = adjustmentSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the stock adjustment.", 422);
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
    return publicError(error);
  }
}
