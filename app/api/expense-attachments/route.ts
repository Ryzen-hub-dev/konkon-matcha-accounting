import { ObjectId } from "mongodb";
import { authorize, created, fail, publicError, sameOrigin } from "@/lib/api";
import { getAttachmentStorageConfig, putPrivateAttachment } from "@/lib/attachment-storage";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { packLosslessPayload, MAX_ATTACHMENT_BYTES } from "@/lib/lossless-storage";

export const runtime = "nodejs";
export const maxDuration = 60;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "text/plain"]);

function safeFileName(value: string) {
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").trim().slice(0, 180) || "evidence";
}

export async function POST(request: Request) {
  const auth = await authorize("expenses.submit");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const form = await request.formData();
    const claimId = String(form.get("claimId") || "");
    const file = form.get("file");
    if (!ObjectId.isValid(claimId) || !(file instanceof File)) return fail("Choose a valid draft claim and evidence file.", 422);
    if (!ALLOWED_TYPES.has(file.type)) return fail("Use a JPEG, PNG, WebP, HEIC, PDF or plain-text evidence file.", 422);
    if (file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) return fail("Evidence files must be between 1 byte and 4 MB.", 422);
    const db = await getDb();
    const [claim, storage] = await Promise.all([
      db.collection("expenseClaims").findOne({ _id: new ObjectId(claimId), claimantId: new ObjectId(auth.session.id), status: "DRAFT" }),
      getAttachmentStorageConfig(db),
    ]);
    if (!claim) return fail("Only your own draft claim can receive new evidence.", 409);
    if (!storage) return fail("The Owner must connect a private GitHub evidence repository before attachments can be uploaded.", 503);
    const attachmentId = new ObjectId();
    const original = Buffer.from(await file.arrayBuffer());
    const context = `expense-attachment:${attachmentId.toHexString()}`;
    const packed = packLosslessPayload(original, context);
    const date = String(claim.expenseDate || "").slice(0, 10);
    const relativePath = `expense-claims/${date.slice(0, 4)}/${date.slice(5, 7)}/${claimId}/${attachmentId.toHexString()}.kkav`;
    const github = await putPrivateAttachment(storage, relativePath, packed.bytes, `Store protected evidence for ${String(claim.claimNo)}`);
    const now = new Date();
    const document = { _id: attachmentId, claimId: claim._id, claimNo: claim.claimNo, originalName: safeFileName(file.name), mimeType: file.type, originalSize: packed.originalSize, storedSize: packed.storedSize, encoding: packed.encoding, sha256: packed.sha256, storageProvider: "GITHUB_PRIVATE", storedPath: github.path, blobSha: github.blobSha, commitSha: github.commitSha, createdBy: new ObjectId(auth.session.id), createdByName: auth.session.fullName, createdAt: now };
    const client = await getMongoClient();
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const claimUpdate = await db.collection("expenseClaims").updateOne({ _id: claim._id, claimantId: claim.claimantId, status: "DRAFT" }, { $inc: { attachmentCount: 1 }, $set: { updatedAt: now } }, { session });
        if (!claimUpdate.matchedCount) throw new Error("CLAIM_CHANGED");
        await db.collection("expenseAttachments").insertOne(document, { session });
        await writeAudit(db, auth.session, "expense_attachment.create", "expenseAttachment", attachmentId.toHexString(), { claimId, claimNo: claim.claimNo, originalName: document.originalName, originalSize: packed.originalSize, storedSize: packed.storedSize, encoding: packed.encoding, sha256: packed.sha256 }, session);
      });
    } finally { await session.endSession(); }
    const { storedPath: _storedPath, blobSha: _blobSha, commitSha: _commitSha, sha256: _sha256, ...safe } = document;
    return created(JSON.parse(JSON.stringify(safe)));
  } catch (error) {
    if (error instanceof Error && error.message === "CLAIM_CHANGED") return fail("The claim changed while evidence was uploading. The protected repository copy was retained for audit recovery.", 409);
    if (error instanceof Error && /GitHub|attachment|evidence|storage|protected/i.test(error.message)) return fail(error.message, 422);
    return publicError(error);
  }
}
