import { ObjectId } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { storeOrderAttachment } from "@/lib/order-attachments";
import { ManagedStorageQuotaError } from "@/lib/storage-control";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const auth = await authorize("commerce.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    if (Number(request.headers.get("content-length") || 0) > 4_500_000)
      return fail("Keep each order attachment at or below 4 MB.", 413);
    const form = await request.formData();
    const id = String(form.get("orderId") || "");
    const file = form.get("file");
    if (!ObjectId.isValid(id) || !(file instanceof File))
      return fail("Choose an order and a file.", 422);
    const db = await getDb();
    const order = await db
      .collection("onlineOrders")
      .findOne({ _id: new ObjectId(id) });
    if (!order) return fail("This order no longer exists.", 404);
    const result = await storeOrderAttachment(
      db,
      order,
      file,
      "STAFF",
      auth.session.fullName,
    );
    await writeAudit(
      db,
      auth.session,
      "commerce.attachment_upload",
      "onlineOrder",
      id,
      {
        orderNo: order.orderNo,
        originalName: result.attachment.originalName,
        originalSize: result.attachment.originalSize,
        storedSize: result.attachment.storedSize,
      },
    );
    return ok(serialise({
      attachment: result.attachment,
      order: result.updated,
    }));
  } catch (error) {
    if (error instanceof ManagedStorageQuotaError)
      return fail(error.message, 507);
    if (
      error instanceof Error &&
      /attachment|file|GitHub|repository|conversation/i.test(error.message)
    )
      return fail(error.message, 422);
    return publicError(error);
  }
}
