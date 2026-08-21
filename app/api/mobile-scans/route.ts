import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { normaliseScanCode, scannerTokenHash } from "@/lib/scanner";
import { getSystemControl } from "@/lib/system-control";

export const runtime = "nodejs";

const connectSchema = z.object({ token: z.string().min(32).max(128), action: z.literal("CONNECT") });
const scanSchema = z.object({ token: z.string().min(32).max(128), code: z.string().min(1).max(128) });
const consumerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const consumeSchema = z.object({ sessionId: z.string().length(24), consumerId: consumerIdSchema, eventIds: z.array(z.string().length(24)).min(1).max(50) });

async function claimPendingEvents(db: Awaited<ReturnType<typeof getDb>>, scannerSessionId: ObjectId, consumerId: string) {
  const owned = await db.collection("scannerEvents").find({ scannerSessionId, consumedAt: null, claimedBy: consumerId }).sort({ createdAt: 1 }).limit(50).toArray();
  if (owned.length) return owned;
  const claimed = [];
  for (let index = 0; index < 50; index += 1) {
    const now = new Date();
    const event = await db.collection("scannerEvents").findOneAndUpdate(
      { scannerSessionId, consumedAt: null, $or: [{ claimedBy: { $exists: false } }, { claimExpiresAt: { $lte: now } }] },
      { $set: { claimedBy: consumerId, claimedAt: now, claimExpiresAt: new Date(now.getTime() + 30_000) } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    if (!event) break;
    claimed.push(event);
  }
  return claimed;
}

async function waitForPendingEvents(db: Awaited<ReturnType<typeof getDb>>, scannerSessionId: ObjectId, consumerId: string, wait: boolean) {
  const startedAt = Date.now();
  do {
    const events = await claimPendingEvents(db, scannerSessionId, consumerId);
    if (events.length || !wait || Date.now() - startedAt >= 3_000) return { events, waitedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (true);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await request.json();
    const connectInput = connectSchema.safeParse(body);
    const input = scanSchema.safeParse(body);
    if (!connectInput.success && !input.success) return fail("The scanner request is invalid.", 422);
    const token = connectInput.success ? connectInput.data.token : input.success ? input.data.token : "";
    const db = await getDb();
    const control = await getSystemControl(db);
    if (control.mode !== "OPEN") return fail("The register is not accepting scans right now.", 423);
    const now = new Date();
    const session = await db.collection("scannerSessions").findOne({
      tokenHash: scannerTokenHash(token),
      revokedAt: { $exists: false },
      expiresAt: { $gt: now },
      generation: control.scannerGeneration,
    });
    if (!session) return fail("This scanner link has expired or was revoked.", 410);
    if (connectInput.success) {
      await db.collection("scannerSessions").updateOne({ _id: session._id }, { $set: { connectedAt: now, updatedAt: now } });
      return ok({ connected: true, label: session.label, purpose: session.purpose || "POS", expiresAt: session.expiresAt });
    }
    if (!input.success) return fail("The scanner request is invalid.", 422);
    const code = normaliseScanCode(input.data.code);
    if (!code) return fail("The scanned code is invalid.", 422);
    const recent = await db.collection("scannerEvents").countDocuments({ scannerSessionId: session._id, createdAt: { $gt: new Date(now.getTime() - 60_000) } });
    if (recent >= 120) return fail("This scanner is sending codes too quickly. Wait a moment.", 429);
    const event = { scannerSessionId: session._id, code, consumedAt: null, expiresAt: session.expiresAt, createdAt: now };
    const result = await db.collection("scannerEvents").insertOne(event);
    await db.collection("scannerSessions").updateOne({ _id: session._id }, { $set: { lastUsedAt: now, updatedAt: now } });
    return created({ eventId: result.insertedId.toHexString(), accepted: true });
  } catch (error) {
    return publicError(error);
  }
}

export async function GET(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") || "";
    const consumerId = url.searchParams.get("consumerId") || "";
    const wait = url.searchParams.get("wait") === "1";
    if (!ObjectId.isValid(sessionId) || !consumerIdSchema.safeParse(consumerId).success) return fail("Choose an active scanner link.", 422);
    const db = await getDb();
    const session = await db.collection("scannerSessions").findOne({ _id: new ObjectId(sessionId), createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
    if (!session) return fail("The scanner link is no longer active.", 410);
    const { events, waitedMs } = await waitForPendingEvents(db, session._id, consumerId, wait);
    const response = ok(events.map((event) => ({ _id: event._id.toHexString(), code: event.code, createdAt: event.createdAt })));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Scanner-Wait-Ms", String(waitedMs));
    return response;
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = consumeSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.sessionId || "") || input.data.eventIds.some((id) => !ObjectId.isValid(id))) return fail("Check the scan acknowledgements.", 422);
    const db = await getDb();
    const session = await db.collection("scannerSessions").findOne({ _id: new ObjectId(input.data.sessionId), createdBy: new ObjectId(auth.session.id) });
    if (!session) return fail("The scanner link could not be found.", 404);
    const result = await db.collection("scannerEvents").updateMany(
      { _id: { $in: input.data.eventIds.map((id) => new ObjectId(id)) }, scannerSessionId: session._id, consumedAt: null, claimedBy: input.data.consumerId },
      { $set: { consumedAt: new Date(), consumedBy: new ObjectId(auth.session.id) } },
    );
    return ok({ consumed: result.modifiedCount });
  } catch (error) {
    return publicError(error);
  }
}
