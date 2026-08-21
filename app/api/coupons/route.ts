import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { CouponError, couponFieldsSchema, couponInputSchema, validateCoupon } from "@/lib/coupons";
import { getDb } from "@/lib/db";
import { asMoney, serialise } from "@/lib/format";

export const runtime = "nodejs";

const updateSchema = couponFieldsSchema.partial().extend({ id: z.string().length(24) });
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
      const memberId = url.searchParams.get("memberId") || null;
      const result = await validateCoupon(db, code, subtotal, memberId);
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
    const document = {
      ...input.data,
      code: input.data.code || generatedCode(),
      value: asMoney(input.data.value),
      minSpend: asMoney(input.data.minSpend),
      usageCount: 0,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("coupons").insertOne(document);
    await writeAudit(db, auth.session, "coupon.create", "coupon", result.insertedId.toHexString(), { code: document.code, type: document.type, value: document.value });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That coupon code already exists.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("coupons.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = updateSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the coupon update.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const { id, ...fields } = input.data;
    const coupon = await (await getDb()).collection("coupons").findOneAndUpdate(
      { _id: new ObjectId(id), archivedAt: { $exists: false } },
      { $set: { ...fields, ...(fields.code ? { code: fields.code.toUpperCase() } : {}), updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!coupon) return fail("The coupon no longer exists.", 404);
    const db = await getDb();
    await writeAudit(db, auth.session, "coupon.update", "coupon", id, { fields: Object.keys(fields) });
    return ok(serialise(coupon));
  } catch (error) {
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
