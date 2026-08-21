import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { currencyMinorUnits } from "@/lib/international";

export const PAYMENT_VERIFICATION_MODES = ["NONE", "REFERENCE", "PROVIDER"] as const;
export const PAYMENT_PROVIDERS = ["GENERIC", "PAYNOW", "DUITNOW", "TNG", "GRABPAY", "ALIPAY", "WECHATPAY", "UNIONPAY"] as const;
export type PaymentVerificationMode = (typeof PAYMENT_VERIFICATION_MODES)[number];
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export function normaliseVerificationCode(value: string) {
  const code = value.normalize("NFKC").trim().toUpperCase();
  return code && code.length <= 128 && /^[\x20-\x7E]+$/.test(code) ? code : "";
}
export function verificationCodeHash(value: string) {
  const code = normaliseVerificationCode(value);
  return code ? createHash("sha256").update(code).digest("base64url") : "";
}

export function signPaymentWebhook(rawBody: string, timestamp: string, secret: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyPaymentWebhook(rawBody: string, timestamp: string, signature: string, secret: string, now = Date.now()) {
  const seconds = Number(timestamp);
  if (!secret || secret.length < 32 || !Number.isInteger(seconds) || Math.abs(now - seconds * 1000) > 5 * 60_000 || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signPaymentWebhook(rawBody, timestamp, secret), "hex");
  const supplied = Buffer.from(signature, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function paymentAmountsMatch(expected: number, actual: number, currency: string) {
  return currencyMinorUnits(expected, currency) === currencyMinorUnits(actual, currency);
}
