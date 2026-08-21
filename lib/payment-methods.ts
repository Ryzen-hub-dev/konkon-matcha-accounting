import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { currencyCodeSchema } from "@/lib/international";
import { PAYMENT_PROVIDERS, PAYMENT_VERIFICATION_MODES, type PaymentProvider, type PaymentVerificationMode } from "@/lib/payment-verification";

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
  verificationMode?: PaymentVerificationMode;
  providerCode?: PaymentProvider;
  qrPayload?: string;
  supportedCurrencies?: string[];
  active: boolean;
  sortOrder: number;
  systemKey?: string;
  createdAt: string;
  updatedAt: string;
};

const codeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,24}$/, "Use 2–24 letters, numbers, dashes or underscores.");

const paymentMethodFields = z.object({
  code: codeSchema,
  name: z.string().trim().min(2).max(60),
  kind: z.enum(PAYMENT_KINDS),
  accountCode: z.string().trim().min(1).max(20),
  referenceRequired: z.coerce.boolean().default(false),
  verificationMode: z.enum(PAYMENT_VERIFICATION_MODES).default("NONE"),
  providerCode: z.enum(PAYMENT_PROVIDERS).optional(),
  qrPayload: z.string().trim().max(4096).refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "The QR payload contains unsupported control characters.").default(""),
  supportedCurrencies: z.array(currencyCodeSchema).max(16).default([]),
  sortOrder: z.coerce.number().int().min(0).max(999).default(100),
});

export const paymentMethodSchema = paymentMethodFields.superRefine((value, context) => {
  if (value.verificationMode === "PROVIDER" && !value.providerCode) {
    context.addIssue({ code: "custom", path: ["providerCode"], message: "Verified provider payments require a provider." });
  }
  if (value.verificationMode === "STATIC_QR" && value.qrPayload.length < 8) {
    context.addIssue({ code: "custom", path: ["qrPayload"], message: "Import an official recipient QR payload before enabling static QR collection." });
  }
});

export const paymentMethodUpdateSchema = paymentMethodFields.partial().extend({
  id: z.string().length(24),
  active: z.coerce.boolean().optional(),
});

export const DEFAULT_PAYMENT_METHODS = [
  { systemKey: "CASH", code: "CASH", name: "Cash", kind: "CASH", accountCode: "1000", accountName: "Cash on hand", referenceRequired: false, verificationMode: "NONE", supportedCurrencies: [], sortOrder: 10 },
  { systemKey: "CARD", code: "CARD", name: "Card", kind: "NON_CASH", accountCode: "1010", accountName: "Bank", referenceRequired: true, verificationMode: "REFERENCE", supportedCurrencies: [], sortOrder: 20 },
  { systemKey: "PAYNOW", code: "PAYNOW", name: "PayNow", kind: "NON_CASH", accountCode: "1010", accountName: "Bank", referenceRequired: true, verificationMode: "PROVIDER", providerCode: "PAYNOW", supportedCurrencies: ["SGD"], sortOrder: 30 },
  { systemKey: "TNG", code: "TNG", name: "Touch 'n Go eWallet", kind: "NON_CASH", accountCode: "1010", accountName: "Bank", referenceRequired: true, verificationMode: "STATIC_QR", providerCode: "TNG", qrPayload: "", supportedCurrencies: ["MYR"], sortOrder: 40, active: false },
] satisfies Array<{ systemKey: string; code: string; name: string; kind: PaymentKind; accountCode: string; accountName: string; referenceRequired: boolean; verificationMode: PaymentVerificationMode; providerCode?: PaymentProvider; qrPayload?: string; supportedCurrencies: string[]; sortOrder: number; active?: boolean }>;

export function effectiveVerificationMode(method: Record<string, unknown>): PaymentVerificationMode {
  if (PAYMENT_VERIFICATION_MODES.includes(method.verificationMode as PaymentVerificationMode)) return method.verificationMode as PaymentVerificationMode;
  if (String(method.code) === "PAYNOW") return "PROVIDER";
  return method.referenceRequired ? "REFERENCE" : "NONE";
}

export function effectiveProvider(method: Record<string, unknown>): PaymentProvider {
  if (PAYMENT_PROVIDERS.includes(method.providerCode as PaymentProvider)) return method.providerCode as PaymentProvider;
  return String(method.code) === "PAYNOW" ? "PAYNOW" : "GENERIC";
}

export function paymentCurrencies(method: Record<string, unknown>, baseCurrency: string, acceptedCurrencies: string[]) {
  const configured = Array.isArray(method.supportedCurrencies) ? method.supportedCurrencies.map(String) : [];
  const allowed = configured.length ? configured : [baseCurrency];
  return [...new Set(allowed.filter((currency) => acceptedCurrencies.includes(currency)))];
}

export async function ensureDefaultPaymentMethods(db: Db, ownerId?: unknown, session?: ClientSession) {
  const now = new Date();
  await db.collection("paymentMethods").bulkWrite(DEFAULT_PAYMENT_METHODS.map((method) => ({
    updateOne: {
      filter: { systemKey: method.systemKey },
      update: { $setOnInsert: { ...method, active: method.active !== false, createdBy: ownerId || null, createdAt: now, updatedAt: now } },
      upsert: true,
    },
  })), session ? { session } : undefined);
}
