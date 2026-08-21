import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { quoteAmount, readExchangeRate } from "@/lib/exchange-rates";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyCodeSchema } from "@/lib/international";
import { effectiveProvider, effectiveVerificationMode, paymentCurrencies } from "@/lib/payment-methods";
import { normaliseVerificationCode, paymentAmountsMatch, verificationCodeHash } from "@/lib/payment-verification";

export const runtime = "nodejs";

const createSchema = z.object({
  paymentMethod: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,24}$/),
  baseAmount: z.coerce.number().positive().max(100_000_000),
  tenderCurrency: currencyCodeSchema,
});
const verifySchema = z.object({ id: z.string().length(24), code: z.string().min(1).max(128) });

class PaymentIntentError extends Error {}

export async function GET(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!ObjectId.isValid(id)) return fail("Choose an active payment verification.", 422);
    const db = await getDb();
    const intent = await db.collection("paymentIntents").findOne({ _id: new ObjectId(id), createdBy: new ObjectId(auth.session.id) });
    if (!intent) return fail("The payment verification could not be found.", 404);
    const response = ok(serialise(intent));
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
    if (!input.success) return fail("Check the payment verification request.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const [method, settings] = await Promise.all([
      db.collection("paymentMethods").findOne({ code: input.data.paymentMethod, active: { $ne: false } }),
      db.collection("settings").findOne({ key: "business" }),
    ]);
    if (!method || effectiveVerificationMode(method) !== "PROVIDER") return fail("Choose a provider-verified payment method.", 422);
    const business = normaliseBusinessSettings(settings);
    const currencies = paymentCurrencies(method, business.currency, business.acceptedCurrencies);
    if (!currencies.includes(input.data.tenderCurrency)) return fail("This payment method does not accept the selected currency.", 422);
    const exchange = await readExchangeRate(db, business.currency, input.data.tenderCurrency);
    if (!exchange) return fail(`No active ${business.currency}/${input.data.tenderCurrency} exchange rate is configured.`, 409);
    const tenderAmount = quoteAmount(input.data.baseAmount, exchange.rate, input.data.tenderCurrency);
    const now = new Date();
    const document = {
      intentNo: makeDocumentNo("PI"),
      paymentMethod: method.code,
      paymentMethodName: method.name,
      provider: effectiveProvider(method),
      baseCurrency: business.currency,
      baseAmount: input.data.baseAmount,
      tenderCurrency: input.data.tenderCurrency,
      tenderAmount,
      exchangeRate: exchange.rate,
      exchangeRateSource: exchange.source,
      status: "PENDING",
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      createdBy: new ObjectId(auth.session.id),
      createdByName: auth.session.fullName,
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("paymentIntents").insertOne(document);
    await writeAudit(db, auth.session, "payment_intent.create", "paymentIntent", result.insertedId.toHexString(), { intentNo: document.intentNo, provider: document.provider, tenderCurrency: document.tenderCurrency, tenderAmount });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = verifySchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the scanned payment code.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const code = normaliseVerificationCode(input.data.code);
    if (!code) return fail("The scanned payment code is invalid.", 422);
    const db = await getDb();
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let verified: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const now = new Date();
        const intent = await db.collection("paymentIntents").findOne({
          _id: new ObjectId(input.data.id), createdBy: new ObjectId(auth.session.id), status: "PENDING", expiresAt: { $gt: now },
        }, { session: mongoSession });
        if (!intent) throw new PaymentIntentError("This payment verification expired or is no longer pending.");
        const confirmation = await db.collection("paymentConfirmations").findOne({
          verificationCodeHash: verificationCodeHash(code), status: "CONFIRMED", claimedByIntentId: { $exists: false },
        }, { session: mongoSession });
        if (!confirmation) throw new PaymentIntentError("No provider-confirmed payment matches this code. Do not release the order.");
        if (String(confirmation.provider) !== String(intent.provider)
          || String(confirmation.paymentMethodCode) !== String(intent.paymentMethod)
          || String(confirmation.currency) !== String(intent.tenderCurrency)
          || !paymentAmountsMatch(Number(intent.tenderAmount), Number(confirmation.amount), String(intent.tenderCurrency))) {
          throw new PaymentIntentError("The confirmed payment does not match the method, currency or exact amount due.");
        }
        const claimed = await db.collection("paymentConfirmations").updateOne(
          { _id: confirmation._id, claimedByIntentId: { $exists: false } },
          { $set: { claimedByIntentId: intent._id, claimedAt: now } },
          { session: mongoSession },
        );
        if (!claimed.modifiedCount) throw new PaymentIntentError("This provider confirmation has already been used.");
        verified = await db.collection("paymentIntents").findOneAndUpdate(
          { _id: intent._id, status: "PENDING" },
          { $set: { status: "VERIFIED", confirmationId: confirmation._id, externalReference: confirmation.externalReference, verifiedAt: now, updatedAt: now } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!verified) throw new PaymentIntentError("The payment verification changed before it could be locked.");
        await writeAudit(db, auth.session, "payment_intent.verify", "paymentIntent", intent._id.toHexString(), { intentNo: intent.intentNo, externalReference: confirmation.externalReference }, mongoSession);
      });
    } finally { await mongoSession.endSession(); }
    return ok(serialise(verified));
  } catch (error) {
    if (error instanceof PaymentIntentError) return fail(error.message, 409);
    return publicError(error);
  }
}
