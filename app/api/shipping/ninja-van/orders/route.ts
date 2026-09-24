import { ObjectId } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { assertDeliveryOrderVersion, nextDeliveryOrderUpdatedAt } from "@/lib/delivery-orders";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { createNinjaVanOrder, ninjaVanBookOrderSchema, NinjaVanError } from "@/lib/ninja-van";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let body: unknown;
  try { body = await request.json(); }
  catch { return fail("The request body must be valid JSON.", 400); }
  const parsed = ninjaVanBookOrderSchema.safeParse(body);
  if (!parsed.success) return fail("Check the Ninja Van booking request.", 422, parsed.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const _id = new ObjectId(parsed.data.id);
    const order = await db.collection("deliveryOrders").findOne({ _id });
    if (!order) return fail("This delivery order could not be found.", 404);
    assertDeliveryOrderVersion(order.updatedAt, parsed.data.expectedUpdatedAt);
    if (order.carrierCode === "NINJA_VAN" && order.trackingReference) return ok(serialise({ ...order, effectiveStatus: order.status }));
    if (order.status !== "DRAFT") return fail("Only a draft delivery order can be booked with a carrier.", 409);
    if (order.carrierCode !== "NINJA_VAN") return fail("Choose Ninja Van and save the shipment details before booking.", 422);

    const provider = await createNinjaVanOrder(db, order);
    const updatedAt = nextDeliveryOrderUpdatedAt(order.updatedAt);
    const updated = await db.collection("deliveryOrders").findOneAndUpdate(
      { _id, status: "DRAFT", updatedAt: order.updatedAt, $or: [{ trackingReference: "" }, { trackingReference: { $exists: false } }] },
      { $set: {
        carrierCode: "NINJA_VAN", carrier: "Ninja Van", trackingReference: provider.trackingNumber,
        providerRequestedTrackingNumber: provider.requestedTrackingNumber,
        providerEnvironment: provider.environment, providerCountryCode: provider.countryCode,
        carrierStatus: "ORDER_ACCEPTED", carrierBookedAt: new Date(), carrierBookedBy: new ObjectId(auth.session.id),
        updatedAt,
      } },
      { returnDocument: "after" },
    );
    if (!updated) {
      const current = await db.collection("deliveryOrders").findOne({ _id });
      if (current?.trackingReference === provider.trackingNumber) return ok(serialise({ ...current, effectiveStatus: current.status }));
      return fail("Ninja Van accepted the stable shipment reference, but this delivery order changed at the same time. Refresh and retry to reconcile it safely.", 409);
    }
    await writeAudit(db, auth.session, "delivery_order.carrier_book", "deliveryOrder", parsed.data.id, {
      deliveryOrderNo: order.deliveryOrderNo,
      provider: "NINJA_VAN",
      environment: provider.environment,
      countryCode: provider.countryCode,
      trackingReference: provider.trackingNumber,
    });
    return ok(serialise({ ...updated, effectiveStatus: updated.status }));
  } catch (error) {
    if (error instanceof NinjaVanError) return fail(error.message, error.status);
    if (error instanceof Error && /changed in another session/.test(error.message)) return fail(error.message, 409);
    return publicError(error);
  }
}
