import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { normaliseScanCode, scannerTokenHash } from "@/lib/scanner";
import { getSystemControl } from "@/lib/system-control";

export const runtime = "nodejs";

const scanSchema = z.object({ token: z.string().min(32).max(128), code: z.string().min(1).max(128) });
const consumeSchema = z.object({ sessionId: z.string().length(24), eventIds: z.array(z.string().length(24)).min(1).max(50) });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = scanSchema.safeParse(await request.json());
    if (!input.success) return fail("The scanner request is invalid.", 422);
    const code = normaliseScanCode(input.data.code);
    if (!code) return fail("The scanned code is invalid.", 422);
    const db = await getDb();
    const control = await getSystemControl(db);
    if (control.mode !== "OPEN") return fail("The register is not accepting scans right now.", 423);
    const now = new Date();
    const session = await db.collection("scannerSessions").findOne({
      tokenHash: scannerTokenHash(input.data.token),
      revokedAt: { $exists: false },
      expiresAt: { $gt: now },
      generation: control.scannerGeneration,
    });
    if (!session) return fail("This scanner link has expired or was revoked.", 410);
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
    if (!ObjectId.isValid(sessionId)) return fail("Choose an active scanner link.", 422);
    const db = await getDb();
    const session = await db.collection("scannerSessions").findOne({ _id: new ObjectId(sessionId), createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
    if (!session) return fail("The scanner link is no longer active.", 410);
    const events = await db.collection("scannerEvents").find({ scannerSessionId: session._id, consumedAt: null }).sort({ createdAt: 1 }).limit(50).toArray();
    return ok(events.map((event) => ({ _id: event._id.toHexString(), code: event.code, createdAt: event.createdAt })));
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
      { _id: { $in: input.data.eventIds.map((id) => new ObjectId(id)) }, scannerSessionId: session._id, consumedAt: null },
      { $set: { consumedAt: new Date(), consumedBy: new ObjectId(auth.session.id) } },
    );
    return ok({ consumed: result.modifiedCount });
  } catch (error) {
    return publicError(error);
  }
}
