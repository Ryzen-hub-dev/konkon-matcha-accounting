import "server-only";
import { ObjectId, type Db } from "mongodb";
import {
  getAttachmentStorageConfig,
  putPrivateAttachment,
} from "@/lib/attachment-storage";
import { safeAttachmentName } from "@/lib/attachment-files";
import { MAX_ATTACHMENT_BYTES, packLosslessPayload } from "@/lib/lossless-storage";
import { orderMessage } from "@/lib/online-orders";
import { assertManagedStorageCapacity } from "@/lib/storage-control";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export async function storeOrderAttachment(
  db: Db,
  order: Record<string, any>,
  file: File,
  sender: "CUSTOMER" | "STAFF",
  staffName = "",
) {
  if (!ALLOWED_TYPES.has(file.type))
    throw new Error("Upload a JPEG, PNG, WebP, GIF, HEIC or PDF file.");
  if (!file.size || file.size > MAX_ATTACHMENT_BYTES)
    throw new Error("Keep each order attachment at or below 4 MB.");
  if (Number(order.attachmentCount || 0) >= 20)
    throw new Error("This order already has 20 attachments.");
  if (Number(order.messageCount || 0) >= 200)
    throw new Error("This order conversation reached its message limit.");
  const storage = await getAttachmentStorageConfig(db);
  if (!storage)
    throw new Error(
      "The Owner must connect a private GitHub evidence repository before images can be shared.",
    );
  const id = new ObjectId();
  const originalName = safeAttachmentName(file.name);
  const bytes = Buffer.from(await file.arrayBuffer());
  const context = `online-order-attachment:${id.toHexString()}`;
  const packed = packLosslessPayload(bytes, context);
  await assertManagedStorageCapacity(db, packed.storedSize);
  const now = new Date();
  const relativePath = `online-orders/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(order._id)}/${id.toHexString()}.kkav`;
  const github = await putPrivateAttachment(
    storage,
    relativePath,
    packed.bytes,
    `Store protected online-order attachment for ${String(order.orderNo)}`,
  );
  const attachment = {
    _id: id,
    orderId: order._id,
    orderNo: order.orderNo,
    originalName,
    mimeType: file.type,
    originalSize: packed.originalSize,
    storedSize: packed.storedSize,
    encoding: packed.encoding,
    sha256: packed.sha256,
    storageProvider: "GITHUB_PRIVATE",
    storedPath: github.path,
    blobSha: github.blobSha,
    commitSha: github.commitSha,
    sender,
    ...(staffName ? { staffName } : {}),
    status: "ACTIVE",
    createdAt: now,
  };
  await db.collection("onlineOrderAttachments").insertOne(attachment);
  const message = orderMessage(sender, `Shared file: ${originalName}`, {
    ...(staffName ? { staffName } : {}),
    type: "ATTACHMENT",
    attachment: {
      id: id.toHexString(),
      name: originalName,
      mimeType: file.type,
      size: packed.originalSize,
    },
  });
  const updated = await db.collection("onlineOrders").findOneAndUpdate(
    {
      _id: order._id,
      attachmentCount: { $lt: 20 },
      messageCount: { $lt: 200 },
    },
    {
      $push: { messages: message as never },
      $inc: { attachmentCount: 1, messageCount: 1 },
      $set: { updatedAt: now },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    await db.collection("onlineOrderAttachments").updateOne(
      { _id: id },
      {
        $set: {
          status: "ORPHANED",
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      },
    );
    throw new Error("The conversation changed before the file could be linked.");
  }
  return { attachment, updated };
}
