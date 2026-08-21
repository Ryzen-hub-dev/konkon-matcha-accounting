import type { ClientSession, Db, WithId, Document } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { asMoney } from "@/lib/format";

export const couponFieldsSchema = z.object({
  code: z.string().trim().max(32).default("").transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2).max(100),
  type: z.enum(["PERCENT", "FIXED"]),
  value: z.coerce.number().positive().max(1_000_000),
  minSpend: z.coerce.number().min(0).max(1_000_000).default(0),
  usageLimit: z.coerce.number().int().min(0).max(1_000_000).default(0),
  perMemberLimit: z.coerce.number().int().min(0).max(10_000).default(0),
  startsAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  active: z.boolean().default(true),
});

export const couponInputSchema = couponFieldsSchema.superRefine((value, context) => {
  if (value.code && !/^[A-Z0-9_-]{3,32}$/.test(value.code)) context.addIssue({ code: "custom", path: ["code"], message: "Use 3–32 letters, numbers, hyphens or underscores." });
  if (value.type === "PERCENT" && value.value > 100) context.addIssue({ code: "custom", path: ["value"], message: "Percentage cannot exceed 100%." });
  if (value.expiresAt <= value.startsAt) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must be after the start time." });
});

export type CouponDocument = WithId<Document> & {
  code: string;
  name: string;
  type: "PERCENT" | "FIXED";
  value: number;
  minSpend: number;
  usageLimit: number;
  perMemberLimit: number;
  startsAt: Date;
  expiresAt: Date;
  active: boolean;
  usageCount?: number;
};

export function computeCouponDiscount(coupon: Pick<CouponDocument, "type" | "value" | "minSpend">, subtotal: number) {
  const cleanSubtotal = asMoney(Math.max(0, subtotal));
  if (cleanSubtotal < Number(coupon.minSpend || 0)) return 0;
  const raw = coupon.type === "PERCENT" ? cleanSubtotal * Number(coupon.value) / 100 : Number(coupon.value);
  return asMoney(Math.min(cleanSubtotal, Math.max(0, raw)));
}

export class CouponError extends Error {}

export async function validateCoupon(db: Db, code: string, subtotal: number, memberId?: string | null, session?: ClientSession) {
  const normalised = code.trim().toUpperCase();
  if (!normalised) return null;
  const coupon = await db.collection("coupons").findOne({ code: normalised, active: true, archivedAt: { $exists: false } }, { session }) as CouponDocument | null;
  if (!coupon) throw new CouponError("That coupon is not active.");
  const now = new Date();
  if (!(coupon.startsAt instanceof Date) || coupon.startsAt > now) throw new CouponError("That coupon has not started yet.");
  if (!(coupon.expiresAt instanceof Date) || coupon.expiresAt <= now) throw new CouponError("That coupon has expired.");
  if (Number(coupon.usageLimit || 0) > 0 && Number(coupon.usageCount || 0) >= Number(coupon.usageLimit)) throw new CouponError("That coupon has reached its usage limit.");
  if (Number(coupon.perMemberLimit || 0) > 0) {
    if (!memberId || !ObjectId.isValid(memberId)) throw new CouponError("Select a member to use this coupon.");
    const used = await db.collection("couponRedemptions").countDocuments({ couponId: coupon._id, memberId: new ObjectId(memberId) }, { session });
    if (used >= Number(coupon.perMemberLimit)) throw new CouponError("This member has reached the coupon limit.");
  }
  if (subtotal < Number(coupon.minSpend || 0)) throw new CouponError(`This coupon requires a minimum spend of ${asMoney(coupon.minSpend).toFixed(2)}.`);
  return { coupon, discount: computeCouponDiscount(coupon, subtotal) };
}
