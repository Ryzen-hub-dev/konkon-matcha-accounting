import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { localPaymentEventSchema } from "@/lib/local-payment-bridge";
import { paymentAmountsMatch } from "@/lib/payment-verification";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorize("payments.manage");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const events = await db.collection("localPaymentEvents")
      .find({}, { projection: { rawContent: 0, sender: 0 } })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();
    const response = ok(serialise(events));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("payments.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let parsedEventId = "";
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return fail("The local payment event must be valid JSON.", 400); }
    const input = localPaymentEventSchema.safeParse(body);
    if (!input.success) return fail("Only a sanitised local payment event can be imported.", 422, input.error.flatten().fieldErrors);
    parsedEventId = input.data.eventId;

    const now = new Date();
    const paidAt = input.data.paidAt;
    if (Math.abs(now.getTime() - paidAt.getTime()) > 24 * 60 * 60_000) {
      return fail("This local payment notification is outside the 24-hour review window.", 409);
    }

    const db = await getDb();
    const existing = await db.collection("localPaymentEvents").findOne({ eventId: input.data.eventId });
    if (existing) return ok(serialise(existing));

    const intentCandidates = await db.collection("paymentIntents").find({
      provider: input.data.provider,
      tenderCurrency: input.data.currency,
      status: "PENDING",
      createdAt: { $gte: new Date(paidAt.getTime() - 15 * 60_000), $lte: new Date(paidAt.getTime() + 5 * 60_000) },
    }, { projection: { intentNo: 1, tenderAmount: 1, createdBy: 1 } }).limit(10).toArray();
    const exactCandidates = intentCandidates.filter((intent) => paymentAmountsMatch(Number(intent.tenderAmount), input.data.amount, input.data.currency));
    const candidate = exactCandidates.length === 1 ? exactCandidates[0] : null;
    const document = {
      ...input.data,
      status: "REQUIRES_REVIEW",
      candidateIntentId: candidate?._id || null,
      candidateIntentNo: candidate?.intentNo || "",
      candidateCount: exactCandidates.length,
      importedBy: new ObjectId(auth.session.id),
      importedByName: auth.session.fullName,
      createdAt: now,
      updatedAt: now,
      expireAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    };
    const result = await db.collection("localPaymentEvents").insertOne(document);
    await writeAudit(db, auth.session, "local-payment-event.import", "localPaymentEvent", result.insertedId.toHexString(), {
      eventId: document.eventId,
      provider: document.provider,
      amount: document.amount,
      currency: document.currency,
      candidateIntentNo: document.candidateIntentNo,
      status: document.status,
    });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      try {
        const existing = parsedEventId ? await (await getDb()).collection("localPaymentEvents").findOne({ eventId: parsedEventId }) : null;
        return existing ? ok(serialise(existing)) : fail("This local payment event was already imported.", 409);
      } catch {
        return fail("This local payment event was already imported.", 409);
      }
    }
    return publicError(error);
  }
}
