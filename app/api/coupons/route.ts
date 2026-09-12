import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { CouponError, couponInputSchema, couponUpdateSchema, validateCoupon, validateCouponAmounts } from "@/lib/coupons";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { normaliseBusinessSettings } from "@/lib/business-settings";

export const runtime = "nodejs";

const deleteSchema = z.object({ id: z.string().length(24) });

function generatedCode() {
  return `MATCHA-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function GET(request: Request) {
  const auth = await authorize("coupons.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim() || "";
    if (code) {
      const subtotal = Math.max(0, Number(url.searchParams.get("subtotal") || 0));
      if (!Number.isFinite(subtotal)) return fail("Use a valid subtotal.", 422);
      const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
      const memberId = url.searchParams.get("memberId") || null;
      const result = await validateCoupon(db, code, subtotal, memberId, undefined, business.currency);
      return ok(serialise({ coupon: result?.coupon, discount: result?.discount || 0 }));
    }
    const includeArchived = url.searchParams.get("includeArchived") === "1" && ["OWNER", "ADMIN", "MANAGER"].includes(auth.session.role);
    const coupons = await db.collection("coupons").find(includeArchived ? {} : { archivedAt: { $exists: false } }).sort({ active: -1, expiresAt: -1 }).limit(500).toArray();
    return ok(serialise(coupons));
  } catch (error) {
    if (error instanceof CouponError) return fail(error.message, 422);
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("coupons.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = couponInputSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the coupon details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const now = new Date();
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const document = {
      ...input.data,
      code: input.data.code || generatedCode(),
      ...validateCouponAmounts(input.data, business.currency),
      usageCount: 0,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("coupons").insertOne(document);
    await writeAudit(db, auth.session, "coupon.create", "coupon", result.insertedId.toHexString(), { code: document.code, type: document.type, value: document.value });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if (error instanceof CouponError) return fail(error.message, 422);
    if ((error as { code?: number }).code === 11000) return fail("That coupon code already exists.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("coupons.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = couponUpdateSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the coupon update.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const { id, ...fields } = input.data;
    const db = await getDb();
    const current = await db.collection("coupons").findOne({ _id: new ObjectId(id), archivedAt: { $exists: false } });
    if (!current) return fail("The coupon no longer exists.", 404);
    const merged = couponInputSchema.safeParse({ ...current, ...fields });
    if (!merged.success) return fail("Check the coupon rules.", 422, merged.error.flatten().fieldErrors);
    if (!merged.data.code) return fail("A saved coupon requires a code.", 422);
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    validateCouponAmounts(merged.data, business.currency);
    const coupon = await db.collection("coupons").findOneAndUpdate(
      { _id: new ObjectId(id), archivedAt: { $exists: false }, ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}) },
      { $set: { ...fields, ...(fields.code ? { code: fields.code.toUpperCase() } : {}), updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!coupon) return fail("The coupon changed. Refresh and try again.", 409);
    await writeAudit(db, auth.session, "coupon.update", "coupon", id, { fields: Object.keys(fields) });
    return ok(serialise(coupon));
  } catch (error) {
    if (error instanceof CouponError) return fail(error.message, 422);
    if ((error as { code?: number }).code === 11000) return fail("That coupon code already exists.", 409);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("coupons.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = deleteSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the coupon reference.", 422);
    const db = await getDb();
    const now = new Date();
    const coupon = await db.collection("coupons").findOneAndUpdate(
      { _id: new ObjectId(input.data.id), archivedAt: { $exists: false } },
      { $set: { active: false, archivedAt: now, archivedBy: new ObjectId(auth.session.id), updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!coupon) return fail("The coupon no longer exists.", 404);
    await writeAudit(db, auth.session, "coupon.archive", "coupon", input.data.id, { code: coupon.code });
    return ok({ archived: true });
  } catch (error) {
    return publicError(error);
  }
}
