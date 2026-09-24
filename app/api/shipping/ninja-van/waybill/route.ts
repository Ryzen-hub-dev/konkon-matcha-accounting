import { Binary, ObjectId } from "mongodb";
import { authorize, fail, publicError } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { getNinjaVanWaybill, NinjaVanError } from "@/lib/ninja-van";

export const runtime = "nodejs";
export const maxDuration = 30;

function pdfResponse(bytes: Buffer, filename: string) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename.replace(/[^A-Za-z0-9_-]/g, "-")}.pdf"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  const id = new URL(request.url).searchParams.get("deliveryOrderId") || "";
  if (!ObjectId.isValid(id)) return fail("The delivery-order reference is invalid.", 422);
  try {
    const db = await getDb();
    const deliveryOrderId = new ObjectId(id);
    const order = await db.collection("deliveryOrders").findOne({ _id: deliveryOrderId });
    if (!order) return fail("This delivery order could not be found.", 404);
    if (order.carrierCode !== "NINJA_VAN" || !order.trackingReference) return fail("This order has no booked Ninja Van shipment.", 422);
    const cached = await db.collection<{ deliveryOrderId: ObjectId; content: Binary }>("shippingWaybills").findOne({ deliveryOrderId });
    if (cached) return pdfResponse(Buffer.from(cached.content.buffer), String(order.deliveryOrderNo || "waybill"));

    const bytes = await getNinjaVanWaybill(db, String(order.trackingReference));
    const now = new Date();
    try {
      await db.collection("shippingWaybills").insertOne({
        deliveryOrderId, provider: "NINJA_VAN", trackingReference: order.trackingReference,
        content: new Binary(bytes), byteLength: bytes.length, createdAt: now,
        expiresAt: new Date(now.getTime() + 180 * 86_400_000),
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    await writeAudit(db, auth.session, "delivery_order.waybill_generate", "deliveryOrder", id, {
      provider: "NINJA_VAN", trackingReference: order.trackingReference, byteLength: bytes.length,
    });
    return pdfResponse(bytes, String(order.deliveryOrderNo || "waybill"));
  } catch (error) {
    if (error instanceof NinjaVanError) return fail(error.message, error.status);
    return publicError(error);
  }
}
