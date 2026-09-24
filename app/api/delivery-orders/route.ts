import { ObjectId } from "mongodb";
import {
  authorize,
  created,
  fail,
  ok,
  publicError,
  sameOrigin,
} from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { dateKeyInTimeZone } from "@/lib/dates";
import {
  assertDeliveryOrderAction,
  assertDeliveryOrderVersion,
  deliveryOrderActionSchema,
  deliveryOrderCarrier,
  deliveryOrderEditSchema,
  deliveryOrderEffectiveStatus,
  deliveryOrderInputSchema,
  DeliveryOrderWorkflowError,
  nextDeliveryOrderUpdatedAt,
} from "@/lib/delivery-orders";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { nextQuotationUpdatedAt } from "@/lib/quotations";

export const runtime = "nodejs";

async function readBody(request: Request) {
  try {
    return { value: await request.json() } as const;
  } catch {
    return {
      error: fail("The request body must be valid JSON.", 400),
    } as const;
  }
}

function withEffectiveStatus(order: Record<string, any>) {
  const today = dateKeyInTimeZone(
    new Date(),
    String(order.businessSnapshot?.timeZone || "UTC"),
  );
  return {
    ...order,
    ...deliveryOrderCarrier(order.carrierCode || order.carrier, order.carrier),
    effectiveStatus: deliveryOrderEffectiveStatus(
      String(order.status),
      order.scheduledDate,
      today,
    ),
  };
}

export async function GET(request: Request) {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = new URL(request.url).searchParams.get("id") || "";
    if (id) {
      if (!ObjectId.isValid(id))
        return fail("The delivery-order reference is invalid.", 422);
      const order = await db
        .collection("deliveryOrders")
        .findOne({ _id: new ObjectId(id) });
      if (!order) return fail("This delivery order could not be found.", 404);
      const carrierEvents =
        order.carrierCode === "NINJA_VAN" && order.trackingReference
          ? await db
              .collection("shippingWebhookEvents")
              .find(
                {
                  provider: "NINJA_VAN",
                  trackingReference: order.trackingReference,
                },
                {
                  projection: {
                    _id: 0,
                    event: 1,
                    status: 1,
                    providerTimestamp: 1,
                    receivedAt: 1,
                    rts: 1,
                  },
                },
              )
              .sort({ providerTimestamp: -1, receivedAt: -1 })
              .limit(100)
              .toArray()
          : [];
      return ok(
        serialise({
          ...withEffectiveStatus(order),
          carrierEvents: carrierEvents.reverse(),
        }),
      );
    }
    const orders = await db
      .collection("deliveryOrders")
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(serialise(orders.map((order) => withEffectiveStatus(order))));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = deliveryOrderInputSchema.safeParse(body.value);
  if (!input.success)
    return fail(
      "Check the delivery-order details.",
      422,
      input.error.flatten().fieldErrors,
    );
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const result = await session.withTransaction(async () => {
        if (input.data.clientRequestId) {
          const existing = await db
            .collection("deliveryOrders")
            .findOne(
              { clientRequestId: input.data.clientRequestId },
              { session },
            );
          if (existing) return { order: existing, isNew: false };
        }
        const sourceQuoteId = new ObjectId(input.data.sourceQuoteId);
        const quotation = await db
          .collection("quotations")
          .findOne({ _id: sourceQuoteId }, { session });
        if (!quotation)
          throw new DeliveryOrderWorkflowError(
            "This source quotation could not be found.",
            404,
          );
        if (
          !quotation.deliveryOrderId &&
          !["ACCEPTED", "CONVERTED"].includes(String(quotation.status))
        ) {
          throw new DeliveryOrderWorkflowError(
            "Only an accepted quotation can create a delivery order.",
          );
        }
        if (quotation.deliveryOrderId) {
          const existing = await db
            .collection("deliveryOrders")
            .findOne({ _id: quotation.deliveryOrderId }, { session });
          if (existing) return { order: existing, isNew: false };
          throw new DeliveryOrderWorkflowError(
            "This quotation already has an unavailable delivery-order reference.",
          );
        }
        if (!Array.isArray(quotation.items) || !quotation.items.length) {
          throw new DeliveryOrderWorkflowError(
            "The source quotation has no deliverable items.",
            422,
          );
        }
        const now = new Date();
        const order = {
          _id: new ObjectId(),
          deliveryOrderNo: makeDocumentNo("DO"),
          sourceQuoteId,
          sourceQuoteNo: quotation.quotationNo,
          ...(input.data.clientRequestId
            ? { clientRequestId: input.data.clientRequestId }
            : {}),
          ...(quotation.memberId
            ? { memberId: quotation.memberId, memberNo: quotation.memberNo }
            : {}),
          ...(quotation.convertedInvoiceId
            ? {
                sourceInvoiceId: quotation.convertedInvoiceId,
                sourceInvoiceNo: quotation.convertedInvoiceNo,
              }
            : {}),
          customerName: quotation.customerName,
          customerEmail: quotation.customerEmail || "",
          customerPhone: quotation.customerPhone || "",
          customerReference: quotation.customerReference || "",
          deliveryAddress: quotation.customerAddress || "",
          contactName: quotation.customerName,
          contactPhone: quotation.customerPhone || "",
          contactEmail: quotation.customerEmail || "",
          deliveryAddress1: quotation.customerAddress || "",
          deliveryAddress2: "",
          deliveryArea: "",
          deliveryCity: "",
          deliveryState: "",
          deliveryCountryCode: quotation.businessSnapshot?.countryCode || "SG",
          deliveryPostcode: "",
          serviceLevel: "Standard",
          pickupRequired: true,
          parcelWeight: 1,
          carrierCode: "OTHER",
          carrier: "",
          trackingReference: "",
          instructions: "",
          scheduledDate: input.data.scheduledDate,
          items: quotation.items.map((item: Record<string, unknown>) => ({
            description: String(item.description || ""),
            quantity: Number(item.quantity || 0),
          })),
          quotedTotal: quotation.total,
          quotedCurrency: quotation.businessSnapshot?.currency,
          businessSnapshot: quotation.businessSnapshot,
          status: "DRAFT",
          createdBy: new ObjectId(auth.session.id),
          createdAt: now,
          updatedAt: now,
        };
        await db.collection("deliveryOrders").insertOne(order, { session });
        const quotationUpdatedAt = nextQuotationUpdatedAt(
          quotation.updatedAt,
          now,
        );
        const updatedQuote = await db
          .collection("quotations")
          .findOneAndUpdate(
            {
              _id: sourceQuoteId,
              status: { $in: ["ACCEPTED", "CONVERTED"] },
              deliveryOrderId: { $exists: false },
            },
            {
              $set: {
                deliveryOrderId: order._id,
                deliveryOrderNo: order.deliveryOrderNo,
                deliveryOrderCreatedAt: now,
                updatedAt: quotationUpdatedAt,
              },
            },
            { returnDocument: "after", session },
          );
        if (!updatedQuote)
          throw new DeliveryOrderWorkflowError(
            "This quotation changed. Refresh it before creating a delivery order.",
          );
        await writeAudit(
          db,
          auth.session,
          "delivery_order.create",
          "deliveryOrder",
          order._id.toHexString(),
          {
            deliveryOrderNo: order.deliveryOrderNo,
            sourceQuoteNo: order.sourceQuoteNo,
          },
          session,
        );
        await writeAudit(
          db,
          auth.session,
          "quotation.delivery_order_create",
          "quotation",
          sourceQuoteId.toHexString(),
          {
            quotationNo: quotation.quotationNo,
            deliveryOrderNo: order.deliveryOrderNo,
          },
          session,
        );
        return { order, isNew: true };
      });
      return result.isNew
        ? created(serialise(withEffectiveStatus(result.order)))
        : ok(serialise(withEffectiveStatus(result.order)));
    } finally {
      await session.endSession();
    }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const db = await getDb();
      const candidates: Record<string, unknown>[] = [
        { sourceQuoteId: new ObjectId(input.data.sourceQuoteId) },
      ];
      if (input.data.clientRequestId)
        candidates.push({ clientRequestId: input.data.clientRequestId });
      const existing = await db
        .collection("deliveryOrders")
        .findOne({ $or: candidates });
      if (existing) return ok(serialise(withEffectiveStatus(existing)));
    }
    if (error instanceof DeliveryOrderWorkflowError)
      return fail(error.message, error.status);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const editing = body.value?.action === "EDIT_DRAFT";
  const parsed = editing
    ? deliveryOrderEditSchema.safeParse(body.value)
    : deliveryOrderActionSchema.safeParse(body.value);
  if (!parsed.success)
    return fail(
      editing
        ? "Check the delivery-order draft."
        : "Check the delivery-order action.",
      422,
      parsed.error.flatten().fieldErrors,
    );
  const input = parsed.data;
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const order = await session.withTransaction(async () => {
        const _id = new ObjectId(input.id);
        const current = await db
          .collection("deliveryOrders")
          .findOne({ _id }, { session });
        if (!current)
          throw new DeliveryOrderWorkflowError(
            "This delivery order could not be found.",
            404,
          );
        assertDeliveryOrderVersion(current.updatedAt, input.expectedUpdatedAt);
        const updatedAt = nextDeliveryOrderUpdatedAt(current.updatedAt);
        const versionFilter = {
          _id,
          status: current.status,
          updatedAt: current.updatedAt,
        };

        if ("scheduledDate" in input) {
          if (current.status !== "DRAFT")
            throw new DeliveryOrderWorkflowError(
              "Only a draft delivery order can be edited.",
            );
          const carrier = deliveryOrderCarrier(
            input.carrierCode,
            input.carrier,
          );
          const changes = {
            scheduledDate: input.scheduledDate,
            deliveryAddress: input.deliveryAddress,
            contactName: input.contactName,
            contactPhone: input.contactPhone,
            contactEmail: input.contactEmail,
            deliveryAddress1: input.deliveryAddress1,
            deliveryAddress2: input.deliveryAddress2,
            deliveryArea: input.deliveryArea,
            deliveryCity: input.deliveryCity,
            deliveryState: input.deliveryState,
            deliveryCountryCode: input.deliveryCountryCode,
            deliveryPostcode: input.deliveryPostcode,
            serviceLevel: input.serviceLevel,
            pickupRequired: input.pickupRequired,
            parcelWeight: input.parcelWeight,
            ...carrier,
            trackingReference: input.trackingReference,
            instructions: input.instructions,
            updatedAt,
          };
          const updated = await db
            .collection("deliveryOrders")
            .findOneAndUpdate(
              versionFilter,
              { $set: changes },
              { returnDocument: "after", session },
            );
          if (!updated)
            throw new DeliveryOrderWorkflowError(
              "This delivery order changed. Refresh it before saving.",
            );
          await writeAudit(
            db,
            auth.session,
            "delivery_order.edit",
            "deliveryOrder",
            input.id,
            {
              deliveryOrderNo: current.deliveryOrderNo,
              scheduledDate: input.scheduledDate,
            },
            session,
          );
          return updated;
        }

        assertDeliveryOrderAction(
          {
            status: current.status,
            deliveryAddress: current.deliveryAddress,
            contactName: current.contactName,
          },
          input.action,
        );
        const status =
          input.action === "DISPATCH"
            ? "DISPATCHED"
            : input.action === "DELIVER"
              ? "DELIVERED"
              : "CANCELLED";
        const eventFields =
          input.action === "DISPATCH"
            ? {
                dispatchedAt: updatedAt,
                dispatchedBy: new ObjectId(auth.session.id),
                dispatchNote: input.note,
              }
            : input.action === "DELIVER"
              ? {
                  deliveredAt: updatedAt,
                  deliveredBy: new ObjectId(auth.session.id),
                  deliveryNote: input.note,
                  receivedBy: input.receivedBy,
                }
              : {
                  cancelledAt: updatedAt,
                  cancelledBy: new ObjectId(auth.session.id),
                  cancellationReason: input.note,
                };
        const updated = await db
          .collection("deliveryOrders")
          .findOneAndUpdate(
            versionFilter,
            { $set: { status, ...eventFields, updatedAt } },
            { returnDocument: "after", session },
          );
        if (!updated)
          throw new DeliveryOrderWorkflowError(
            "This delivery order changed. Refresh it before trying again.",
          );
        await writeAudit(
          db,
          auth.session,
          `delivery_order.${input.action.toLowerCase()}`,
          "deliveryOrder",
          input.id,
          {
            deliveryOrderNo: current.deliveryOrderNo,
            previousStatus: current.status,
            status,
            note: input.note,
            receivedBy: input.receivedBy || null,
          },
          session,
        );
        return updated;
      });
      return ok(serialise(withEffectiveStatus(order)));
    } finally {
      await session.endSession();
    }
  } catch (error) {
    if (error instanceof DeliveryOrderWorkflowError)
      return fail(error.message, error.status);
    return publicError(error);
  }
}
