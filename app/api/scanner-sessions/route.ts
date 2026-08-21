import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { createScannerToken, scannerTokenHash, SCANNER_SESSION_MS } from "@/lib/scanner";
import { getSystemControl } from "@/lib/system-control";

export const runtime = "nodejs";

const createSchema = z.object({ label: z.string().trim().min(2).max(60).default("Mobile scanner") });
const revokeSchema = z.object({ id: z.string().length(24) });

export async function GET() {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const control = await getSystemControl(db);
    const now = new Date();
    const sessions = await db.collection("scannerSessions").find({
      createdBy: new ObjectId(auth.session.id),
      revokedAt: { $exists: false },
      expiresAt: { $gt: now },
      generation: control.scannerGeneration,
    }, { projection: { tokenHash: 0 } }).sort({ createdAt: -1 }).limit(10).toArray();
    return ok(serialise({ sessions, mode: control.mode }));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = createSchema.safeParse(await request.json());
    if (!input.success) return fail("Name this scanner link.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const control = await getSystemControl(db);
    if (control.mode !== "OPEN") return fail("Scanner links can only be issued while the workspace is open.", 423);
    const activeCount = await db.collection("scannerSessions").countDocuments({ createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() }, generation: control.scannerGeneration });
    if (activeCount >= 5) return fail("Revoke an active scanner link before creating another.", 409);
    const token = createScannerToken();
    const now = new Date();
    const document = {
      label: input.data.label,
      tokenHash: scannerTokenHash(token),
      generation: control.scannerGeneration,
      createdBy: new ObjectId(auth.session.id),
      createdByName: auth.session.fullName,
      expiresAt: new Date(now.getTime() + SCANNER_SESSION_MS),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("scannerSessions").insertOne(document);
    await writeAudit(db, auth.session, "scanner.issue", "scannerSession", result.insertedId.toHexString(), { label: document.label, expiresAt: document.expiresAt });
    const url = new URL(`/scan/${token}`, request.url).toString();
    return created(serialise({ session: { _id: result.insertedId, ...document, tokenHash: undefined }, url }));
  } catch (error) {
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = revokeSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the scanner link reference.", 422);
    const db = await getDb();
    const now = new Date();
    const result = await db.collection("scannerSessions").updateOne(
      { _id: new ObjectId(input.data.id), createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false } },
      { $set: { revokedAt: now, revokedBy: new ObjectId(auth.session.id), updatedAt: now } },
    );
    if (!result.modifiedCount) return fail("The scanner link is already inactive.", 404);
    await writeAudit(db, auth.session, "scanner.revoke", "scannerSession", input.data.id);
    return ok({ revoked: true });
  } catch (error) {
    return publicError(error);
  }
}
