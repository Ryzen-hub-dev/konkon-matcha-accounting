import { ObjectId } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { getAttachmentStorageConfig, getPrivateAttachment } from "@/lib/attachment-storage";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { unpackLosslessPayload } from "@/lib/lossless-storage";
import { hasPermission } from "@/lib/rbac";
import { attachmentContentDisposition } from "@/lib/attachment-files";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorize("expenses.read");
  if (auth.error) return auth.error;
  try {
    const { id } = await context.params;
    if (!ObjectId.isValid(id)) return fail("The evidence reference is invalid.", 422);
    const db = await getDb();
    const attachment = await db.collection("expenseAttachments").findOne({ _id: new ObjectId(id) });
    if (!attachment) return fail("This evidence file could not be found.", 404);
    if (attachment.status === "REMOVED" && auth.session.role !== "OWNER") return fail("This evidence file was removed from the claim.", 404);
    const claim = await db.collection("expenseClaims").findOne({ _id: attachment.claimId }, { projection: { claimantId: 1, claimNo: 1 } });
    const canReview = hasPermission(auth.session.role, "expenses.approve") || hasPermission(auth.session.role, "expenses.pay");
    if (!claim || (!canReview && String(claim.claimantId) !== auth.session.id)) return fail("You do not have permission to open this evidence.", 403);
    const storage = await getAttachmentStorageConfig(db);
    if (!storage) return fail("Private evidence storage is not configured.", 503);
    const protectedBytes = await getPrivateAttachment(storage, String(attachment.storedPath));
    const output = unpackLosslessPayload(protectedBytes, `expense-attachment:${id}`);
    const download = new URL(request.url).searchParams.get("download") === "1";
    await writeAudit(db, auth.session, download ? "expense_attachment.download" : "expense_attachment.view", "expenseAttachment", id, { claimNo: claim.claimNo, originalName: attachment.originalName });
    return new Response(output, { status: 200, headers: { "Content-Type": String(attachment.mimeType || "application/octet-stream"), "Content-Length": String(output.length), "Content-Disposition": attachmentContentDisposition(attachment.originalName, download), "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" } });
  } catch (error) {
    if (error instanceof Error && /GitHub|attachment|evidence|storage|integrity|protected/i.test(error.message)) return fail(error.message, 422);
    return publicError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorize("expenses.submit");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const { id } = await context.params;
    if (!ObjectId.isValid(id)) return fail("The evidence reference is invalid.", 422);
    const db = await getDb();
    const attachmentId = new ObjectId(id);
    const attachment = await db.collection("expenseAttachments").findOne({ _id: attachmentId, status: { $ne: "REMOVED" } });
    if (!attachment) return fail("This evidence is no longer attached to the claim.", 409);
    const claim = await db.collection("expenseClaims").findOne({ _id: attachment.claimId, claimantId: new ObjectId(auth.session.id), status: "DRAFT" });
    if (!claim) return fail("Evidence can only be removed from your own draft claim.", 409);
    const client = await getMongoClient();
    const session = client.startSession();
    let attachmentCount = Number(claim.attachmentCount || 0);
    try {
      await session.withTransaction(async () => {
        const removed = await db.collection("expenseAttachments").updateOne(
          { _id: attachmentId, claimId: claim._id, status: { $ne: "REMOVED" } },
          { $set: { status: "REMOVED", removedAt: new Date(), removedBy: new ObjectId(auth.session.id), removedByName: auth.session.fullName } },
          { session },
        );
        if (!removed.modifiedCount) throw new Error("ATTACHMENT_CHANGED");
        const updatedClaim = await db.collection("expenseClaims").findOneAndUpdate(
          { _id: claim._id, claimantId: claim.claimantId, status: "DRAFT", attachmentCount: { $gt: 0 } },
          { $inc: { attachmentCount: -1 }, $set: { updatedAt: new Date() } },
          { returnDocument: "after", session },
        );
        if (!updatedClaim) throw new Error("ATTACHMENT_CHANGED");
        attachmentCount = Number(updatedClaim.attachmentCount || 0);
        await writeAudit(db, auth.session, "expense_attachment.remove", "expenseAttachment", id, { claimNo: claim.claimNo, originalName: attachment.originalName, repositoryCopyRetained: true }, session);
      });
    } finally { await session.endSession(); }
    return ok({ id, status: "REMOVED", attachmentCount, repositoryCopyRetained: true });
  } catch (error) {
    if (error instanceof Error && error.message === "ATTACHMENT_CHANGED") return fail("The claim or evidence changed before removal. Reload and try again.", 409);
    return publicError(error);
  }
}
