import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { currencyCodeSchema } from "@/lib/international";
import { PAYMENT_PROVIDERS } from "@/lib/payment-verification";

export const LOCAL_PAYMENT_EVENT_SOURCE = "LOCAL_USB_SMS" as const;

export const localPaymentEventSchema = z.object({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.enum(PAYMENT_PROVIDERS),
  amount: z.number().positive().max(100_000_000_000),
  currency: currencyCodeSchema,
  paidAt: z.coerce.date(),
  externalReference: z.string().trim().max(80).default(""),
  recipientAccountMasked: z.string().trim().max(32).default(""),
  senderFingerprint: z.string().regex(/^[a-f0-9]{16}$/),
  confidence: z.number().min(0).max(1),
  source: z.literal(LOCAL_PAYMENT_EVENT_SOURCE),
}).strict();

export type SanitizedLocalPaymentEvent = z.infer<typeof localPaymentEventSchema>;

export type LocalPaymentParseResult =
  | { accepted: true; event: SanitizedLocalPaymentEvent }
  | { accepted: false; reason: "INVALID_INPUT" | "PRIVACY_BLOCKED" | "SENDER_NOT_ALLOWED" | "NOT_PAYMENT" | "OUTGOING_PAYMENT" | "AMOUNT_MISSING" };

export function normaliseLocalBridgePath(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

const OTP_OR_SECRET = /\b(?:otp|tac|pin|password|passcode|verification\s*code|security\s*code|one[-\s]?time\s*password|login\s*code)\b|验证码|校验码|动态密码|登录码|一次性密码|安全码/i;
const PAYMENT_RECEIVED = /\b(?:payment\s+received|transfer\s+received|incoming\s+transfer|credited|credit\s+of|received|has\s+paid|paid\s+you|dikreditkan|diterima)\b|入账|到账|收款|已收款|收到|转入|已存入|支付成功/i;
const OUTGOING_PAYMENT = /\b(?:debited|you\s+paid|payment\s+to|sent\s+to|purchase|spent|withdrawal|cash\s+out)\b|扣账|扣款|消费|付款给|转出|支出|提款/i;

const AMOUNT_PATTERNS: Array<{ currency: string; pattern: RegExp }> = [
  { currency: "MYR", pattern: /(?:\bMYR\b|\bRM)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i },
  { currency: "SGD", pattern: /(?:\bSGD\b|S\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i },
  { currency: "USD", pattern: /(?:\bUSD\b|US\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i },
  { currency: "CNY", pattern: /(?:\bCNY\b|\bRMB\b|CN¥)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i },
  { currency: "JPY", pattern: /(?:\bJPY\b|JP¥)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i },
  { currency: "EUR", pattern: /(?:\bEUR\b|€)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i },
  { currency: "GBP", pattern: /(?:\bGBP\b|£)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i },
];

const PROVIDER_PATTERNS: Array<{ provider: (typeof PAYMENT_PROVIDERS)[number]; pattern: RegExp }> = [
  { provider: "TNG", pattern: /touch\s*['’]?n\s*go|\btng\b/i },
  { provider: "PAYNOW", pattern: /paynow/i },
  { provider: "DUITNOW", pattern: /duitnow/i },
  { provider: "ALIPAY", pattern: /alipay/i },
  { provider: "WECHATPAY", pattern: /wechat\s*pay|微信支付/i },
  { provider: "GRABPAY", pattern: /grab\s*pay/i },
  { provider: "UNIONPAY", pattern: /union\s*pay|银联/i },
];

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function signSmsForwarderWebhook(timestamp: string, secret: string) {
  return createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
}

export function verifySmsForwarderWebhook(timestamp: string, signature: string, secret: string, now = Date.now()) {
  const milliseconds = Number(timestamp);
  if (!secret || secret.length < 16 || !Number.isInteger(milliseconds) || Math.abs(now - milliseconds) > 5 * 60_000) return false;
  let supplied = signature.trim().replaceAll(" ", "+");
  try { supplied = decodeURIComponent(supplied); } catch { return false; }
  return safeEqual(signSmsForwarderWebhook(timestamp, secret), supplied);
}

function providerFromMessage(value: string) {
  return PROVIDER_PATTERNS.find((candidate) => candidate.pattern.test(value))?.provider || "GENERIC";
}

function amountFromMessage(value: string) {
  for (const candidate of AMOUNT_PATTERNS) {
    const match = value.match(candidate.pattern);
    const amount = Number(match?.[1]?.replaceAll(",", ""));
    if (Number.isFinite(amount) && amount > 0 && amount <= 100_000_000_000) return { amount, currency: candidate.currency };
  }
  return null;
}

function referenceFromMessage(value: string) {
  const match = value.match(/(?:ref(?:erence)?|transaction(?:\s+id)?|txn(?:\s+id)?|receipt|参考号|交易号|编号)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,79})/i);
  return match?.[1]?.toUpperCase() || "";
}

function maskedRecipientFromMessage(value: string) {
  const match = value.match(/(?:account|a\/c|wallet|账户|户口).{0,18}?([*Xx•·-]{2,}[0-9]{2,6})/i);
  return match?.[1]?.replace(/[Xx•·-]/g, "*").slice(-12) || "";
}

function senderIsAllowed(sender: string, allowedSenders: string[]) {
  if (!allowedSenders.length) return true;
  const normalized = sender.trim().toLocaleLowerCase("en-US");
  return allowedSenders.some((allowed) => allowed.trim().toLocaleLowerCase("en-US") === normalized);
}

function normaliseTimestamp(value: string | number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return numeric > 0 && numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
}

export function parseLocalPaymentNotification(input: {
  sender: string;
  content: string;
  timestamp: string | number;
  receivedAt?: string;
}, options: { secret: string; allowedSenders?: string[] } ): LocalPaymentParseResult {
  const sender = String(input.sender || "").normalize("NFKC").trim().slice(0, 120);
  const content = String(input.content || "").normalize("NFKC").trim();
  const timestamp = normaliseTimestamp(input.timestamp);
  if (!sender || !content || content.length > 8_000 || !Number.isFinite(timestamp)) return { accepted: false, reason: "INVALID_INPUT" };
  if (!senderIsAllowed(sender, options.allowedSenders || [])) return { accepted: false, reason: "SENDER_NOT_ALLOWED" };
  if (OTP_OR_SECRET.test(content)) return { accepted: false, reason: "PRIVACY_BLOCKED" };
  if (OUTGOING_PAYMENT.test(content)) return { accepted: false, reason: "OUTGOING_PAYMENT" };
  if (!PAYMENT_RECEIVED.test(content)) return { accepted: false, reason: "NOT_PAYMENT" };
  const amount = amountFromMessage(content);
  if (!amount) return { accepted: false, reason: "AMOUNT_MISSING" };

  const parsedReceivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date(timestamp);
  const paidAt = Number.isFinite(parsedReceivedAt.getTime()) ? parsedReceivedAt : new Date(timestamp);
  const provider = providerFromMessage(`${sender} ${content}`);
  const externalReference = referenceFromMessage(content);
  const recipientAccountMasked = maskedRecipientFromMessage(content);
  const senderFingerprint = createHmac("sha256", options.secret).update(sender).digest("hex").slice(0, 16);
  const eventId = createHash("sha256").update([
    LOCAL_PAYMENT_EVENT_SOURCE,
    senderFingerprint,
    String(timestamp),
    provider,
    amount.currency,
    String(amount.amount),
    externalReference,
  ].join("|")).digest("hex");
  const confidence = Math.min(1, 0.65 + (provider !== "GENERIC" ? 0.15 : 0) + (externalReference ? 0.15 : 0) + (recipientAccountMasked ? 0.05 : 0));

  return {
    accepted: true,
    event: {
      eventId,
      provider,
      amount: amount.amount,
      currency: amount.currency,
      paidAt,
      externalReference,
      recipientAccountMasked,
      senderFingerprint,
      confidence,
      source: LOCAL_PAYMENT_EVENT_SOURCE,
    },
  };
}
