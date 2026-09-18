import { ObjectId } from "mongodb";
import { authorize, fail, publicError } from "@/lib/api";
import { getAttachmentStorageConfig, getPrivateAttachment } from "@/lib/attachment-storage";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { unpackLosslessPayload } from "@/lib/lossless-storage";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorize("expenses.read");
  if (auth.error) return auth.error;
  try {
    const { id } = await context.params;
    if (!ObjectId.isValid(id)) return fail("The evidence reference is invalid.", 422);
    const db = await getDb();
    const attachment = await db.collection("expenseAttachments").findOne({ _id: new ObjectId(id) });
    if (!attachment) return fail("This evidence file could not be found.", 404);
    const claim = await db.collection("expenseClaims").findOne({ _id: attachment.claimId }, { projection: { claimantId: 1, claimNo: 1 } });
    const canReview = hasPermission(auth.session.role, "expenses.approve") || hasPermission(auth.session.role, "expenses.pay");
    if (!claim || (!canReview && String(claim.claimantId) !== auth.session.id)) return fail("You do not have permission to open this evidence.", 403);
    const storage = await getAttachmentStorageConfig(db);
    if (!storage) return fail("Private evidence storage is not configured.", 503);
    const protectedBytes = await getPrivateAttachment(storage, String(attachment.storedPath));
    const output = unpackLosslessPayload(protectedBytes, `expense-attachment:${id}`);
    await writeAudit(db, auth.session, "expense_attachment.download", "expenseAttachment", id, { claimNo: claim.claimNo, originalName: attachment.originalName });
    const originalName = String(attachment.originalName || "evidence").replace(/[\r\n"]/g, "_");
    return new Response(output, { status: 200, headers: { "Content-Type": String(attachment.mimeType || "application/octet-stream"), "Content-Length": String(output.length), "Content-Disposition": `attachment; filename="${originalName.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(originalName)}`, "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    if (error instanceof Error && /GitHub|attachment|evidence|storage|integrity|protected/i.test(error.message)) return fail(error.message, 422);
    return publicError(error);
  }
}
