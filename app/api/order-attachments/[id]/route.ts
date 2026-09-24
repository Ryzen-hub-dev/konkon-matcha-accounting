import { ObjectId } from "mongodb";
import { authorize, fail, publicError } from "@/lib/api";
import { attachmentContentDisposition } from "@/lib/attachment-files";
import {
  getAttachmentStorageConfig,
  getPrivateAttachment,
} from "@/lib/attachment-storage";
import { getDb } from "@/lib/db";
import { unpackLosslessPayload } from "@/lib/lossless-storage";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await authorize("commerce.read");
  if (auth.error) return auth.error;
  try {
    const { id } = await context.params;
    if (!ObjectId.isValid(id)) return fail("This order file is unavailable.", 404);
    const db = await getDb();
    const [attachment, storage] = await Promise.all([
      db.collection("onlineOrderAttachments").findOne({
        _id: new ObjectId(id),
        status: "ACTIVE",
      }),
      getAttachmentStorageConfig(db),
    ]);
    if (!attachment || !storage)
      return fail("This order file is unavailable.", 404);
    const protectedBytes = await getPrivateAttachment(
      storage,
      String(attachment.storedPath),
    );
    const bytes = unpackLosslessPayload(
      protectedBytes,
      `online-order-attachment:${id}`,
    );
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": String(attachment.mimeType || "application/octet-stream"),
        "Content-Length": String(bytes.length),
        "Content-Disposition": attachmentContentDisposition(
          attachment.originalName,
          new URL(request.url).searchParams.get("download") === "1",
        ),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return publicError(error);
  }
}
