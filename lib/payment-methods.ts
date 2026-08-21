import type { ClientSession, Db } from "mongodb";
import { z } from "zod";

export const PAYMENT_KINDS = ["CASH", "NON_CASH"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export type PaymentMethodRecord = {
  _id: string;
  code: string;
  name: string;
  kind: PaymentKind;
  accountCode: string;
  accountName: string;
  referenceRequired: boolean;
  active: boolean;
  sortOrder: number;
  systemKey?: string;
  createdAt: string;
  updatedAt: string;
};

const codeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,24}$/, "Use 2–24 letters, numbers, dashes or underscores.");

export const paymentMethodSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(2).max(60),
  kind: z.enum(PAYMENT_KINDS),
  accountCode: z.string().trim().min(1).max(20),
  referenceRequired: z.coerce.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(999).default(100),
});

export const paymentMethodUpdateSchema = paymentMethodSchema.partial().extend({
  id: z.string().length(24),
  active: z.coerce.boolean().optional(),
});

export const DEFAULT_PAYMENT_METHODS = [
  { systemKey: "CASH", code: "CASH", name: "Cash", kind: "CASH", accountCode: "1000", accountName: "Cash on hand", referenceRequired: false, sortOrder: 10 },
  { systemKey: "CARD", code: "CARD", name: "Card", kind: "NON_CASH", accountCode: "1010", accountName: "Bank", referenceRequired: false, sortOrder: 20 },
  { systemKey: "PAYNOW", code: "PAYNOW", name: "PayNow", kind: "NON_CASH", accountCode: "1010", accountName: "Bank", referenceRequired: false, sortOrder: 30 },
] satisfies Array<{ systemKey: string; code: string; name: string; kind: PaymentKind; accountCode: string; accountName: string; referenceRequired: boolean; sortOrder: number }>;

export async function ensureDefaultPaymentMethods(db: Db, ownerId?: unknown, session?: ClientSession) {
  const now = new Date();
  await db.collection("paymentMethods").bulkWrite(DEFAULT_PAYMENT_METHODS.map((method) => ({
    updateOne: {
      filter: { systemKey: method.systemKey },
      update: { $setOnInsert: { ...method, active: true, createdBy: ownerId || null, createdAt: now, updatedAt: now } },
      upsert: true,
    },
  })), session ? { session } : undefined);
}
