import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  currencyCodeSchema,
  currencyMinorUnits,
  roundCurrency,
} from "@/lib/international";

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);

export const bankConnectionMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("CREATE"),
      name: z.string().trim().min(2).max(80),
      provider: z
        .string()
        .trim()
        .toUpperCase()
        .min(2)
        .max(40)
        .regex(/^[A-Z0-9_-]+$/),
      accountCode: z.string().trim().min(3).max(12),
      externalAccountId: z.string().trim().max(100).default(""),
    })
    .strict(),
  z.object({ action: z.literal("ROTATE_SECRET"), id: objectId }).strict(),
  z
    .object({
      action: z.literal("SET_ACTIVE"),
      id: objectId,
      active: z.boolean(),
    })
    .strict(),
]);

export const bankFeedEventSchema = z
  .object({
    eventId: z.string().trim().min(4).max(120),
    postedAt: z.string().datetime({ offset: true }),
    amount: z
      .number()
      .finite()
      .refine(
        (value) => value !== 0 && Math.abs(value) <= 100_000_000,
        "Use a non-zero amount within the supported range.",
      ),
    currency: currencyCodeSchema,
    description: z.string().trim().min(2).max(200),
    reference: z.string().trim().max(100).default(""),
    runningBalance: z
      .number()
      .finite()
      .min(-100_000_000)
      .max(100_000_000)
      .optional(),
  })
  .strict();

export const bankFeedPayloadSchema = z
  .object({ events: z.array(bankFeedEventSchema).min(1).max(100) })
  .strict()
  .superRefine((value, context) => {
    const ids = value.events.map((event) => event.eventId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "Each event ID can appear only once per request.",
      });
  });

export function generateBankFeedSecret() {
  return randomBytes(32).toString("base64url");
}

export function signBankFeed(
  secret: string,
  timestamp: string,
  rawBody: string,
) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

export function verifyBankFeedSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  now = Date.now(),
) {
  const time = Number(timestamp);
  if (
    !Number.isInteger(time) ||
    Math.abs(now - time * 1_000) > 5 * 60_000 ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    return false;
  const expected = Buffer.from(signBankFeed(secret, timestamp, rawBody), "hex");
  const received = Buffer.from(signature, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export function normaliseBankFeedEvent(
  event: z.infer<typeof bankFeedEventSchema>,
  currency: string,
) {
  if (event.currency !== currency)
    throw new Error(`The bank feed currency must be ${currency}.`);
  const amount = roundCurrency(event.amount, currency);
  if (
    currencyMinorUnits(amount, currency) !==
      currencyMinorUnits(event.amount, currency) ||
    Math.abs(amount - event.amount) > 1e-8
  ) {
    throw new Error(`Use the supported decimal precision for ${currency}.`);
  }
  const runningBalance =
    event.runningBalance === undefined
      ? undefined
      : roundCurrency(event.runningBalance, currency);
  if (
    runningBalance !== undefined &&
    Math.abs(runningBalance - event.runningBalance!) > 1e-8
  )
    throw new Error(`Use the supported decimal precision for ${currency}.`);
  return {
    ...event,
    amount,
    ...(runningBalance === undefined ? {} : { runningBalance }),
    postedAt: new Date(event.postedAt),
  };
}
