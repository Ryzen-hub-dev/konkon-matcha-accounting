import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { buildAmountLockedDuitNowQr } from "@/lib/duitnow-qr";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { roundCurrency } from "@/lib/international";
import { effectiveProvider, effectiveVerificationMode, paymentCurrencies } from "@/lib/payment-methods";
import {
  createPaymentDisplayToken,
  paymentDisplayTokenHash,
  PAYMENT_DISPLAY_SESSION_MS,
  PAYMENT_DISPLAY_THANK_YOU_MS,
} from "@/lib/payment-display";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getSystemControl } from "@/lib/system-control";

export const runtime = "nodejs";

const idSchema = z.string().length(24);
const createSchema = z.object({ label: z.string().trim().min(2).max(60).default("Customer payment screen") });
const updateSchema = z.discriminatedUnion("action", [
  z.object({ id: idSchema, action: z.literal("WELCOME") }),
  z.object({ id: idSchema, action: z.literal("THANK_YOU") }),
  z.object({
    id: idSchema,
    action: z.literal("DISPLAY"),
    paymentMethodCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,24}$/),
    amount: z.number().finite().positive().max(100_000_000_000),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  }),
]);
const revokeSchema = z.object({ id: idSchema });

function summaryProjection() {
  return { tokenHash: 0, qrPayload: 0 } as const;
}

export async function GET() {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const sessions = await db.collection("paymentDisplaySessions").find({
      createdBy: new ObjectId(auth.session.id),
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    }, { projection: summaryProjection() }).sort({ lastSeenAt: -1, createdAt: -1 }).limit(5).toArray();
    const response = ok(serialise({ sessions }));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = createSchema.safeParse(await request.json());
    if (!input.success) return fail("Name this payment screen.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const control = await getSystemControl(db);
    if (control.mode !== "OPEN") return fail("Payment screens can only be linked while the workspace is open.", 423);
    const now = new Date();
    const activeCount = await db.collection("paymentDisplaySessions").countDocuments({
      createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false }, expiresAt: { $gt: now }, generation: control.scannerGeneration,
    });
    if (activeCount >= 3) return fail("Revoke an active payment screen before linking another.", 409);
    const token = createPaymentDisplayToken();
    const document = {
      label: input.data.label,
      tokenHash: paymentDisplayTokenHash(token),
      generation: control.scannerGeneration,
      phase: "WELCOME",
      stateVersion: 1,
      createdBy: new ObjectId(auth.session.id),
      createdByName: auth.session.fullName,
      expiresAt: new Date(now.getTime() + PAYMENT_DISPLAY_SESSION_MS),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("paymentDisplaySessions").insertOne(document);
    await writeAudit(db, auth.session, "payment-display.issue", "paymentDisplaySession", result.insertedId.toHexString(), { label: document.label, expiresAt: document.expiresAt });
    const url = new URL(`/pay-display/${token}`, request.url).toString();
    return created(serialise({ session: { _id: result.insertedId, ...document, tokenHash: undefined }, url }));
  } catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = updateSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the payment-screen update.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const db = await getDb();
    const control = await getSystemControl(db);
    if (control.mode !== "OPEN") return fail("The customer payment screen is paused while the workspace is closed.", 423);
    const now = new Date();
    const filter = {
      _id: new ObjectId(input.data.id), createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false }, expiresAt: { $gt: now }, generation: control.scannerGeneration,
    };

    let update: Record<string, unknown>;
    if (input.data.action === "DISPLAY") {
      const [method, settings] = await Promise.all([
        db.collection("paymentMethods").findOne({ code: input.data.paymentMethodCode, active: { $ne: false } }),
        db.collection("settings").findOne({ key: "business" }),
      ]);
      if (!method || effectiveVerificationMode(method) !== "STATIC_QR" || !String(method.qrPayload || "")) {
        return fail("Choose an active payment method with an official recipient QR.", 422);
      }
      const business = normaliseBusinessSettings(settings);
      const allowedCurrencies = paymentCurrencies(method, business.currency, business.acceptedCurrencies);
      if (!allowedCurrencies.includes(input.data.currency)) return fail("This payment method does not accept the selected currency.", 422);
      const provider = effectiveProvider(method);
      const amount = roundCurrency(input.data.amount, input.data.currency);
      let qrPayload = String(method.qrPayload);
      let amountLocked = false;
      try {
        const locked = buildAmountLockedDuitNowQr(qrPayload, amount, input.data.currency);
        qrPayload = locked.payload;
        amountLocked = true;
      } catch (error) {
        if (provider === "TNG" || String(method.code) === "TNG") {
          return fail(error instanceof Error ? error.message : "Import an official DuitNow recipient QR before using TNG amount locking.", 422);
        }
      }
      update = {
        $set: {
          phase: "PAYMENT", paymentMethodCode: String(method.code), paymentName: String(method.name), provider,
          amount, currency: input.data.currency, qrPayload, amountLocked, updatedAt: now,
        },
        $unset: { thankYouUntil: "" },
        $inc: { stateVersion: 1 },
      };
    } else if (input.data.action === "THANK_YOU") {
      update = {
        $set: { phase: "THANK_YOU", thankYouUntil: new Date(now.getTime() + PAYMENT_DISPLAY_THANK_YOU_MS), updatedAt: now },
        $unset: { paymentMethodCode: "", paymentName: "", provider: "", amount: "", currency: "", qrPayload: "", amountLocked: "" },
        $inc: { stateVersion: 1 },
      };
    } else {
      update = {
        $set: { phase: "WELCOME", updatedAt: now },
        $unset: { paymentMethodCode: "", paymentName: "", provider: "", amount: "", currency: "", qrPayload: "", amountLocked: "", thankYouUntil: "" },
        $inc: { stateVersion: 1 },
      };
    }

    const session = await db.collection("paymentDisplaySessions").findOneAndUpdate(filter, update, { returnDocument: "after", projection: summaryProjection() });
    if (!session) return fail("This payment-screen link has expired or was revoked.", 410);
    return ok(serialise(session));
  } catch (error) { return publicError(error); }
}

export async function DELETE(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = revokeSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the payment-screen reference.", 422);
    const db = await getDb();
    const now = new Date();
    const result = await db.collection("paymentDisplaySessions").updateOne(
      { _id: new ObjectId(input.data.id), createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false } },
      { $set: { revokedAt: now, revokedBy: new ObjectId(auth.session.id), phase: "WELCOME", updatedAt: now }, $unset: { qrPayload: "", amount: "", currency: "" } },
    );
    if (!result.modifiedCount) return fail("This payment-screen link is already inactive.", 404);
    await writeAudit(db, auth.session, "payment-display.revoke", "paymentDisplaySession", input.data.id);
    return ok({ revoked: true });
  } catch (error) { return publicError(error); }
}
