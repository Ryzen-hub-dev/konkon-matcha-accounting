import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { createScannerToken, scannerTokenHash, SCANNER_SESSION_MS } from "@/lib/scanner";
import { scannerActivityAt, scannerPurpose, scannerPermission, SCANNER_PURPOSES } from "@/lib/scanner-routing";
import { hasPermission } from "@/lib/rbac";
import { getSystemControl } from "@/lib/system-control";
import { OwnerRecoveryError, readOwnerRecoveryJson } from "@/lib/owner-recovery";

export const runtime = "nodejs";

const purposeSchema = z.enum(SCANNER_PURPOSES);
const createSchema = z.object({ label: z.string().trim().min(2).max(60).default("Mobile scanner"), purpose: purposeSchema.default("POS"), bindingMemberId: z.string().regex(/^[a-f0-9]{24}$/).optional(), sharedReader: z.boolean().default(false) });
const routeSchema = z.object({ id: z.string().length(24), purpose: purposeSchema, bindingMemberId: z.string().regex(/^[a-f0-9]{24}$/).optional(), bindingLeaseId: z.string().uuid().optional() }).strict();
const revokeSchema = z.object({ id: z.string().length(24) });

export async function GET(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const control = await getSystemControl(db);
    const now = new Date();
    const requestedPurpose = purposeSchema.safeParse(new URL(request.url).searchParams.get("purpose") || "POS");
    if (!requestedPurpose.success) return fail("Choose a valid scanner purpose.", 422);
    if (!hasPermission(auth.session.role, scannerPermission(requestedPurpose.data))) return fail("You cannot use this scanner destination.", 403);
    const sessions = await db.collection("scannerSessions").find({
      ...(requestedPurpose.data === "MEMBER_BIND" ? { purpose: "MEMBER_BIND", bindingMemberId: new URL(request.url).searchParams.get("memberId") || "" } : { purpose: { $ne: "MEMBER_BIND" } }),
      createdBy: new ObjectId(auth.session.id),
      ownerSessionVersion: auth.session.sessionVersion,
      revokedAt: { $exists: false },
      expiresAt: { $gt: now },
      generation: control.scannerGeneration,
    }, { projection: { tokenHash: 0 } }).sort({ createdAt: -1 }).limit(10).toArray();
    const normalised = sessions
      .map((session) => ({ ...session, purpose: scannerPurpose(session.purpose) }))
      .sort((left, right) => scannerActivityAt(right) - scannerActivityAt(left));
    return ok(serialise({ sessions: normalised, mode: control.mode }));
  } catch (error) {
    return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = createSchema.safeParse(await readOwnerRecoveryJson(request));
    if (!input.success) return fail("Name this scanner link.", 422, input.error.flatten().fieldErrors);
    if (!hasPermission(auth.session.role, scannerPermission(input.data.purpose))) return fail("You cannot use this scanner destination.", 403);
    const db = await getDb();
    const control = await getSystemControl(db);
    if (control.mode !== "OPEN") return fail("Scanner links can only be issued while the workspace is open.", 423);
    if (input.data.purpose === "MEMBER_BIND" && (!input.data.bindingMemberId || !await db.collection("members").findOne({ _id: new ObjectId(input.data.bindingMemberId), active: { $ne: false } }))) return fail("Choose an active member for this NFC reader.", 422);
    const activeCount = await db.collection("scannerSessions").countDocuments({ createdBy: new ObjectId(auth.session.id), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() }, generation: control.scannerGeneration });
    if (activeCount >= 5) return fail("Revoke an active scanner link before creating another.", 409);
    const token = createScannerToken();
    const now = new Date();
    const document = {
      label: input.data.label,
      purpose: input.data.purpose,
      ...(input.data.purpose === "MEMBER_BIND" ? { bindingMemberId: input.data.bindingMemberId } : {}),
      ...(input.data.purpose === "MEMBER_BIND" && input.data.sharedReader ? { bindingLeaseId: randomUUID(), resumePurpose: "MEMBERS" } : {}),
      tokenHash: scannerTokenHash(token),
      generation: control.scannerGeneration,
      createdBy: new ObjectId(auth.session.id),
      ownerSessionVersion: auth.session.sessionVersion,
      createdByName: auth.session.fullName,
      expiresAt: new Date(now.getTime() + SCANNER_SESSION_MS),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("scannerSessions").insertOne(document);
    await writeAudit(db, auth.session, "scanner.issue", "scannerSession", result.insertedId.toHexString(), { label: document.label, purpose: document.purpose, expiresAt: document.expiresAt });
    const url = new URL(`/scan/${token}`, request.url).toString();
    return created(serialise({ session: { _id: result.insertedId, ...document, tokenHash: undefined }, url }));
  } catch (error) {
    return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = routeSchema.safeParse(await readOwnerRecoveryJson(request));
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Choose an active scanner destination.", 422);
    if (!hasPermission(auth.session.role, scannerPermission(input.data.purpose))) return fail("You cannot use this scanner destination.", 403);
    const db = await getDb();
    const control = await getSystemControl(db);
    if (control.mode !== "OPEN") return fail("Scanner routing can only change while the workspace is open.", 423);
    const now = new Date();
    const owned = { _id: new ObjectId(input.data.id), createdBy: new ObjectId(auth.session.id), ownerSessionVersion: auth.session.sessionVersion, revokedAt: { $exists: false }, expiresAt: { $gt: now }, generation: control.scannerGeneration };
    const previous = await db.collection("scannerSessions").findOne(owned);
    if (!previous) return fail("The scanner link is no longer active.", 410);
    if (input.data.purpose === "MEMBER_BIND") {
      const { bindingMemberId, bindingLeaseId } = input.data;
      if (!bindingMemberId || !bindingLeaseId) return fail("Choose a member and start a new card binding.", 422);
      if (!await db.collection("members").findOne({ _id: new ObjectId(bindingMemberId), active: { $ne: false } })) return fail("Choose an active member for this NFC reader.", 422);
      if (previous.purpose === "MEMBER_BIND") {
        if (previous.bindingMemberId === bindingMemberId && previous.bindingLeaseId === bindingLeaseId) return ok(serialise({ ...previous, tokenHash: undefined }));
        return fail("Finish the current member binding before using this phone here.", 409);
      }
      const borrowed = await db.collection("scannerSessions").findOneAndUpdate(
        { ...owned, purpose: { $ne: "MEMBER_BIND" } },
        { $set: { purpose: "MEMBER_BIND", bindingMemberId, bindingLeaseId, resumePurpose: scannerPurpose(previous.purpose), routedAt: now, updatedAt: now } },
        { returnDocument: "after", projection: { tokenHash: 0 } },
      );
      if (!borrowed) return fail("This phone changed destination. Reload and try again.", 409);
      await writeAudit(db, auth.session, "scanner.binding_start", "scannerSession", input.data.id, { memberId: bindingMemberId });
      return ok(serialise(borrowed));
    }
    if (previous.purpose === "MEMBER_BIND") {
      if (!hasPermission(auth.session.role, "members.write")) return fail("You cannot finish this member binding.", 403);
      if (!previous.bindingLeaseId || previous.bindingLeaseId !== input.data.bindingLeaseId || previous.bindingMemberId !== input.data.bindingMemberId) return fail("The scanner link is locked to a member binding.", 410);
      const released = await db.collection("scannerSessions").findOneAndUpdate(
        { ...owned, purpose: "MEMBER_BIND", bindingMemberId: input.data.bindingMemberId, bindingLeaseId: input.data.bindingLeaseId },
        { $set: { purpose: input.data.purpose, routedAt: now, updatedAt: now }, $unset: { bindingMemberId: "", bindingLeaseId: "", resumePurpose: "" } },
        { returnDocument: "after", projection: { tokenHash: 0 } },
      );
      if (!released) return fail("This binding has already changed. Reload the reader.", 409);
      await db.collection("scannerEvents").updateMany({ scannerSessionId: previous._id, bindingLeaseId: input.data.bindingLeaseId, consumedAt: null }, { $set: { consumedAt: now } });
      await writeAudit(db, auth.session, "scanner.binding_finish", "scannerSession", input.data.id, { memberId: input.data.bindingMemberId, purpose: input.data.purpose });
      return ok(serialise(released));
    }
    if (input.data.bindingLeaseId || input.data.bindingMemberId) return fail("This binding has already finished. Reload the reader.", 409);
    const session = await db.collection("scannerSessions").findOneAndUpdate(
      {
        ...owned,
        purpose: { $ne: "MEMBER_BIND" },
        createdBy: new ObjectId(auth.session.id),
        revokedAt: { $exists: false },
        expiresAt: { $gt: now },
        generation: control.scannerGeneration,
      },
      { $set: { purpose: input.data.purpose, routedAt: now, updatedAt: now } },
      { returnDocument: "after", projection: { tokenHash: 0 } },
    );
    if (!session) return fail("The scanner link is no longer active.", 410);
    await writeAudit(db, auth.session, "scanner.route", "scannerSession", input.data.id, { purpose: input.data.purpose });
    return ok(serialise({ ...session, purpose: input.data.purpose }));
  } catch (error) {
    return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = revokeSchema.safeParse(await readOwnerRecoveryJson(request));
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
    return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : publicError(error);
  }
}
