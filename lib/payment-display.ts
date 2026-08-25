import { createHash, randomBytes } from "node:crypto";

export const PAYMENT_DISPLAY_SESSION_MS = 24 * 60 * 60 * 1_000;
export const PAYMENT_DISPLAY_THANK_YOU_MS = 5_000;
export const PAYMENT_DISPLAY_PHASES = ["WELCOME", "PAYMENT", "THANK_YOU"] as const;
export type PaymentDisplayPhase = (typeof PAYMENT_DISPLAY_PHASES)[number];

export function createPaymentDisplayToken() {
  return randomBytes(32).toString("base64url");
}

export function paymentDisplayTokenHash(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}
