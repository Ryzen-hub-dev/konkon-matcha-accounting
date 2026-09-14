import { ObjectId, type Db, type Document } from "mongodb";
import { z } from "zod";
import { authorize, fail, ok, created, sameOrigin } from "@/lib/api";
import { getDb, getMongoClient, scopedCollectionName } from "@/lib/db";
import { serialise } from "@/lib/format";
import { writeAudit } from "@/lib/audit";
import { cardCreateSchema, cardStyleSchema, cardUpdateSchema, decryptMemberToken, encryptMemberToken, memberBindingHashFromCode, memberTokenHash, newMemberToken } from "@/lib/member-cards";
import { OwnerRecoveryError, readOwnerRecoveryJson } from "@/lib/owner-recovery";
import { hasPermission } from "@/lib/rbac";
import { getSystemControl } from "@/lib/system-control";

export const runtime = "nodejs";
const projection = { tokenHash: 0, encryptedToken: 0, bindingHash: 0, clientRequestId: 0 };
function errorResponse(error: unknown) {
  return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : fail("The member card service is temporarily unavailable.", 503);
}

// Serialize card creation with member deletion and concurrent card issues.
async function insertCard(db: Db, card: Document & { memberId: ObjectId }) {
  const session = (await getMongoClient()).startSession();
  try {
    return await session.withTransaction(async () => {
      const member = await db.collection("members").updateOne({ _id: card.memberId, active: { $ne: false } }, { $inc: { cardRevision: 1 } }, { session });
      if (!member.matchedCount) throw new OwnerRecoveryError("The member is inactive.", 410);
      if (await db.collection("memberCards").countDocuments({ memberId: card.memberId, status: { $in: ["ACTIVE", "SUSPENDED"] } }, { session }) >= 20) throw new OwnerRecoveryError("Maximum 20 current cards per member. Void an unused card first.", 409);
      await db.collection("memberCards").insertOne(card, { session });
    });
  } finally { await session.endSession(); }
}

export async function GET(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  if (url.searchParams.get("orphaned") === "1") {
    if (!hasPermission(auth.session.role, "members.write")) return fail("You do not have permission to review orphaned NFC registrations.", 403);
    try {
      const db = await getDb();
      // Filter orphaned registrations before limiting: newer live cards must
      // not hide an older deleted member's card from the cleanup screen.
      const cards = await db.collection("memberCards").aggregate([
        { $match: { kind: "BOUND", status: { $in: ["ACTIVE", "SUSPENDED", "VOID"] } } },
        { $lookup: { from: scopedCollectionName("members"), localField: "memberId", foreignField: "_id", pipeline: [{ $project: { name: 1, memberNo: 1, active: 1, archivedAt: 1 } }], as: "owner" } },
        { $match: { $or: [{ "owner.0": { $exists: false } }, { "owner.active": false }] } },
        { $sort: { updatedAt: -1 } }, { $limit: 100 }, { $project: projection },
      ]).toArray();
      const orphanedCards = cards.map(({ owner, ...card }) => {
        const member = owner[0];
        return {
          ...card,
          member: member ? { name: member.name, memberNo: member.memberNo, archivedAt: member.archivedAt || null } : null,
          reason: "MEMBER_ARCHIVED_OR_MISSING" as const,
        };
      });
      return ok(serialise(orphanedCards));
    } catch (error) { return errorResponse(error); }
  }
  const memberId = url.searchParams.get("memberId") || "";
  if (!ObjectId.isValid(memberId)) return fail("Choose a member.", 422);
  try {
    const db = await getDb();
    return ok(serialise(await db.collection("memberCards").find({ memberId: new ObjectId(memberId), status: { $ne: "DELETED" } }, { projection }).sort({ createdAt: -1 }).limit(100).toArray()));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("members.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await readOwnerRecoveryJson(request) as Record<string, unknown>;
    const db = await getDb();
    if (body?.action === "REVEAL") {
      if (typeof body.id !== "string" || !ObjectId.isValid(body.id)) return fail("Choose a card.", 422);
      const card = await db.collection("memberCards").findOne({ _id: new ObjectId(body.id), status: "ACTIVE" });
      if (!card || !await db.collection("members").findOne({ _id: card.memberId, active: { $ne: false } })) return fail("This card or member is inactive.", 410);
      const token = decryptMemberToken(card.encryptedToken, card._id.toHexString());
      await writeAudit(db, auth.session, "member_card.reveal", "memberCard", card._id.toHexString());
      return ok({ token });
    }
    if (body?.action === "CLEAR_ORPHAN") {
      const rawCode = typeof body.code === "string" && body.code.length <= 512 ? body.code : "";
      const binding = rawCode ? memberBindingHashFromCode(rawCode) : null;
      const id = typeof body.id === "string" && ObjectId.isValid(body.id) ? body.id : "";
      if (!binding && !id) return fail("Scan the bound NFC card or choose an orphaned registration.", 422);
      const selector = binding ? { bindingHash: binding.bindingHash } : { _id: new ObjectId(id) };
      const card = await db.collection("memberCards").findOne({ ...selector, kind: "BOUND" });
      if (!card) return fail("This NFC registration could not be found.", 410);
      if (!["ACTIVE", "SUSPENDED", "VOID"].includes(String(card.status))) return fail("This NFC registration is already cleared.", 410);
      const member = card.memberId instanceof ObjectId
        ? await db.collection("members").findOne({ _id: card.memberId }, { projection: { name: 1, memberNo: 1, active: 1 } })
        : null;
      if (member && member.active !== false) return fail("Only an NFC card whose member is archived can be cleared.", 409);
      const result = await db.collection("memberCards").updateOne(
        { _id: card._id, kind: "BOUND", status: { $in: ["ACTIVE", "SUSPENDED", "VOID"] } },
        { $set: { status: "DELETED", deletedAt: new Date(), updatedAt: new Date() }, $unset: { bindingHash: "" } },
      );
      if (!result.modifiedCount) return fail("This NFC registration was already cleared.", 409);
      await writeAudit(db, auth.session, "member_card.clear_orphan", "memberCard", card._id.toHexString(), { memberId: card.memberId?.toHexString?.() || "missing", reason: "member_archived_or_missing", source: card.bindingSource || "unknown" });
      return ok({ cleared: true, id: card._id.toHexString(), memberId: card.memberId?.toHexString?.() || null });
    }
    if (body?.action === "BIND") {
      if (typeof body.memberId !== "string" || !ObjectId.isValid(body.memberId) || typeof body.code !== "string" || typeof body.clientRequestId !== "string") return fail("Scan an NFC card and choose a member.", 422);
      const binding = memberBindingHashFromCode(body.code);
      if (!binding) return fail("This NFC card could not be identified by the browser. Use QR or a supported NDEF reader.", 422);
      const input = cardStyleSchema.safeParse({ label: body.label || "Existing NFC card", tier: body.tier || "MATCHA CLUB", accentColor: body.accentColor || "#173f2a" });
      if (!input.success || !z.string().uuid().safeParse(body.clientRequestId).success) return fail("Check the existing card details.", 422);
      const memberId = new ObjectId(body.memberId);
      if (body.readerSessionId !== undefined) {
        if (typeof body.readerSessionId !== "string" || !ObjectId.isValid(body.readerSessionId)) return fail("Choose the connected NFC reader.", 422);
        const control = await getSystemControl(db);
        const reader = await db.collection("scannerSessions").findOne({ _id: new ObjectId(body.readerSessionId), createdBy: new ObjectId(auth.session.id), purpose: "MEMBER_BIND", bindingMemberId: body.memberId, generation: control.scannerGeneration, ownerSessionVersion: auth.session.sessionVersion, expiresAt: { $gt: new Date() }, revokedAt: { $exists: false } });
        if (control.mode !== "OPEN" || !reader) return fail("The NFC reader expired or belongs to another member. Read the card again.", 410);
        if (reader.bindingLeaseId && reader.bindingLeaseId !== body.readerBindingLeaseId) return fail("This card binding has changed. Read the card again.", 409);
      }
      if (!await db.collection("members").findOne({ _id: memberId, active: { $ne: false } })) return fail("The member is inactive.", 410);
      const existingRequest = await db.collection("memberCards").findOne({ clientRequestId: body.clientRequestId, memberId }, { projection });
      if (existingRequest) return ok(serialise(existingRequest));
      const existingBinding = await db.collection("memberCards").findOne({ bindingHash: binding.bindingHash });
      if (existingBinding) {
        if (existingBinding.memberId.equals(memberId) && existingBinding.status === "ACTIVE") return ok(serialise(await db.collection("memberCards").findOne({ _id: existingBinding._id }, { projection })));
        return fail(existingBinding.status === "VOID" ? "This NFC card was permanently voided. Use another card." : "This NFC card is already bound to another member.", 409);
      }
      if (await db.collection("memberCards").countDocuments({ memberId, status: { $in: ["ACTIVE", "SUSPENDED"] } }) >= 20) return fail("Void an unused card before adding another. Maximum 20 current cards per member.", 409);
      const _id = new ObjectId(); const now = new Date();
      const card = { _id, memberId, clientRequestId: body.clientRequestId, label: input.data.label, tier: input.data.tier, accentColor: input.data.accentColor,
        kind: "BOUND", bindingSource: binding.source, bindingHash: binding.bindingHash, last4: binding.fingerprint.slice(-4).toUpperCase(), status: "ACTIVE", createdAt: now, updatedAt: now, createdBy: new ObjectId(auth.session.id) };
      try { await insertCard(db, card); }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; const retry = await db.collection("memberCards").findOne({ bindingHash: binding.bindingHash }, { projection }); return retry?.memberId?.equals(memberId) ? ok(serialise(retry)) : fail("This NFC card is already bound. Reload and try another card.", 409); }
      await writeAudit(db, auth.session, "member_card.bind", "memberCard", _id.toHexString(), { memberId: memberId.toHexString(), source: binding.source });
      return created(serialise(await db.collection("memberCards").findOne({ _id }, { projection })));
    }
    const input = cardCreateSchema.safeParse(body);
    if (!input.success) return fail("Check the card details.", 422, input.error.flatten().fieldErrors);
    const memberId = new ObjectId(input.data.memberId);
    if (!await db.collection("members").findOne({ _id: memberId, active: { $ne: false } })) return fail("The member is inactive.", 410);
    const existing = await db.collection("memberCards").findOne({ clientRequestId: input.data.clientRequestId, memberId }, { projection });
    if (existing) return ok(serialise(existing));
    if (await db.collection("memberCards").countDocuments({ memberId, status: { $in: ["ACTIVE", "SUSPENDED"] } }) >= 20) return fail("Void an unused card before issuing another. Maximum 20 current cards per member.", 409);
    const _id = new ObjectId();
    const token = newMemberToken(); const now = new Date();
    const card = { _id, memberId, clientRequestId: input.data.clientRequestId, label: input.data.label, tier: input.data.tier, accentColor: input.data.accentColor,
      tokenHash: memberTokenHash(token), encryptedToken: encryptMemberToken(token, _id.toHexString()), last4: token.slice(-4), status: "ACTIVE", createdAt: now, updatedAt: now, createdBy: new ObjectId(auth.session.id) };
    try { await insertCard(db, card); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; const retry = await db.collection("memberCards").findOne({ clientRequestId: input.data.clientRequestId, memberId }, { projection }); return retry ? ok(serialise(retry)) : fail("Card request conflicts with another issue. Reload and try again.", 409); }
    await writeAudit(db, auth.session, "member_card.issue", "memberCard", _id.toHexString(), { memberId: memberId.toHexString(), tier: card.tier });
    return created(serialise(await db.collection("memberCards").findOne({ _id }, { projection })));
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("members.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = cardUpdateSchema.safeParse(await readOwnerRecoveryJson(request));
    if (!input.success) return fail("Check the card update.", 422);
    const { id, ...changes } = input.data;
    if (!Object.keys(changes).length) return fail("Choose a card change.", 422);
    const db = await getDb();
    const card = await db.collection("memberCards").findOneAndUpdate({ _id: new ObjectId(id), status: { $in: ["ACTIVE", "SUSPENDED"] } }, { $set: { ...changes, updatedAt: new Date() }, ...(changes.status === "VOID" ? { $unset: { encryptedToken: "" } } : {}) }, { returnDocument: "after", projection });
    if (!card) return fail("Voided or deleted cards cannot be changed. Issue a replacement.", 409);
    await writeAudit(db, auth.session, "member_card.update", "memberCard", id, changes);
    return ok(serialise(card));
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  const auth = await authorize("members.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await readOwnerRecoveryJson(request) as { id?: unknown };
    if (typeof body?.id !== "string" || !ObjectId.isValid(body.id)) return fail("Choose a card.", 422);
    const db = await getDb();
    const result = await db.collection("memberCards").updateOne({ _id: new ObjectId(body.id), status: { $ne: "DELETED" } }, { $set: { status: "DELETED", deletedAt: new Date(), updatedAt: new Date() }, $unset: { encryptedToken: "", bindingHash: "", tokenHash: "" } });
    if (!result.modifiedCount) return fail("This card is already deleted.", 404);
    await writeAudit(db, auth.session, "member_card.delete", "memberCard", body.id);
    return ok({ deleted: true });
  } catch (error) { return errorResponse(error); }
}
