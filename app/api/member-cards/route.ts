import { ObjectId } from "mongodb";
import { authorize, fail, ok, created, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { writeAudit } from "@/lib/audit";
import { cardCreateSchema, cardUpdateSchema, decryptMemberToken, encryptMemberToken, memberTokenHash, newMemberToken } from "@/lib/member-cards";
import { OwnerRecoveryError, readOwnerRecoveryJson } from "@/lib/owner-recovery";

export const runtime = "nodejs";
const projection = { tokenHash: 0, encryptedToken: 0, clientRequestId: 0 };
function errorResponse(error: unknown) {
  return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : fail("The member card service is temporarily unavailable.", 503);
}

export async function GET(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  const memberId = new URL(request.url).searchParams.get("memberId") || "";
  if (!ObjectId.isValid(memberId)) return fail("Choose a member.", 422);
  try {
    const db = await getDb();
    return ok(serialise(await db.collection("memberCards").find({ memberId: new ObjectId(memberId) }, { projection }).sort({ createdAt: -1 }).limit(100).toArray()));
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
    try { await db.collection("memberCards").insertOne(card); }
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
    const result = await db.collection("memberCards").updateOne({ _id: new ObjectId(body.id), status: { $ne: "DELETED" } }, { $set: { status: "DELETED", deletedAt: new Date(), updatedAt: new Date() }, $unset: { encryptedToken: "" } });
    if (!result.modifiedCount) return fail("This card is already deleted.", 404);
    await writeAudit(db, auth.session, "member_card.delete", "memberCard", body.id);
    return ok({ deleted: true });
  } catch (error) { return errorResponse(error); }
}
