import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { roundCurrency } from "@/lib/international";
import { calculateTaxTotals, type TaxMode } from "@/lib/tax";
import { quoteAmount } from "@/lib/exchange-rates";
import { assessRefund, writeOperationalReview } from "@/lib/operational-reviews";
import { addInventoryBatchQuantity, BatchInventoryError, sliceBatchAllocations } from "@/lib/inventory-batches";

export const runtime = "nodejs";

const refundSchema = z.object({
  saleId: z.string().length(24),
  counterId: z.union([z.string().length(24), z.literal("")]).optional(),
  clientRequestId: z.string().uuid().optional(),
  reason: z.string().trim().min(3).max(240),
  items: z.array(z.object({ productId: z.string().length(24), quantity: z.coerce.number().int().min(1).max(999) })).min(1).max(100),
});

class ShiftError extends Error {}
class InventoryLocationError extends Error {}

async function readBody(request: Request) {
  try {
    return { value: await request.json() } as const;
  } catch {
    return { error: fail("The request body must be valid JSON.", 400) } as const;
  }
}

export async function GET(request: Request) {
  const auth = await authorize("receipts.read");
  if (auth.error) return auth.error;
  const saleId = new URL(request.url).searchParams.get("saleId") || "";
  if (!ObjectId.isValid(saleId)) return fail("The sale reference is invalid.", 422);
  try {
    const db = await getDb();
    const refunds = await db.collection("refunds").find({ saleId: new ObjectId(saleId) }).sort({ createdAt: -1 }).toArray();
    return ok(serialise(refunds));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("receipts.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = refundSchema.safeParse(body.value);
  if (!input.success || !ObjectId.isValid(input.data?.saleId || "")) {
    return fail("Check the refund details.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
  }

  const requested = new Map<string, number>();
  for (const item of input.data.items) requested.set(item.productId, (requested.get(item.productId) || 0) + item.quantity);

  try {
    const db = await getDb();
    if (input.data.clientRequestId) {
      const existing = await db.collection("refunds").findOne({ clientRequestId: input.data.clientRequestId });
      if (existing) return ok(serialise(existing));
    }
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let refund: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const saleId = new ObjectId(input.data.saleId);
        const sale = await db.collection("sales").findOne({ _id: saleId }, { session: mongoSession });
        if (!sale || !["COMPLETED", "PARTIALLY_REFUNDED"].includes(String(sale.status))) {
          throw new Error("REFUND_NOT_AVAILABLE");
        }

        const counterIdValue = input.data.counterId || String(sale.counterId || "");
        const counterId = ObjectId.isValid(counterIdValue) ? new ObjectId(counterIdValue) : null;
        const [openShift, shiftControl] = counterId ? await Promise.all([
          db.collection("registerShifts").findOne({ counterId, status: "OPEN" }, { session: mongoSession }),
          db.collection("registerShifts").findOne({ counterId }, { projection: { _id: 1 }, session: mongoSession }),
        ]) : [null, null];
        if (shiftControl && !openShift) throw new ShiftError("Open a register shift for this counter before posting the refund.");
        if (openShift) {
          const activeShift = await db.collection("registerShifts").updateOne(
            { _id: openShift._id, counterId, status: "OPEN" },
            { $set: { lastActivityAt: new Date(), lastRefundAt: new Date() } },
            { session: mongoSession },
          );
          if (!activeShift.matchedCount) throw new ShiftError("The register shift closed before the refund was posted.");
        }

        const currency = String(sale.businessSnapshot?.currency || "SGD");
        const money = (value: unknown) => roundCurrency(value, currency);
        const saleItems = Array.isArray(sale.items) ? sale.items : [];
        const itemMap = new Map(saleItems.map((item) => [item.productId.toString(), item]));
        for (const [productId, quantity] of requested) {
          const item = itemMap.get(productId);
          const remaining = Number(item?.quantity || 0) - Number(item?.refundedQuantity || 0);
          if (!item || quantity > remaining) throw new Error("REFUND_QUANTITY_INVALID");
        }

        const refundItems = [...requested.entries()].map(([productId, quantity]) => {
          const item = itemMap.get(productId)!;
          const batchResult = Array.isArray(item.batchAllocations) && item.batchAllocations.length
            ? sliceBatchAllocations(item.batchAllocations, Number(item.refundedQuantity || 0), quantity)
            : { allocations: [], shortage: 0 };
          if (batchResult.shortage) throw new BatchInventoryError(`${String(item.name)} batch allocation history is incomplete. Review the original receipt before refunding.`);
          return {
            productId: item.productId,
            sku: String(item.sku || ""),
            name: String(item.name),
            quantity,
            price: money(item.price),
            cost: money(item.cost),
            lineSubtotal: money(Number(item.price) * quantity),
            lineCost: money(Number(item.cost) * quantity),
            batchAllocations: batchResult.allocations,
          };
        });

        const updatedItems = saleItems.map((item) => {
          const refundQuantity = requested.get(item.productId.toString()) || 0;
          return refundQuantity ? {
            ...item,
            refundedQuantity: Number(item.refundedQuantity || 0) + refundQuantity,
            refundedLineTotal: money(Number(item.refundedLineTotal || 0) + Number(item.price) * refundQuantity),
          } : item;
        });
        const isFinalRefund = updatedItems.every((item) => Number(item.refundedQuantity || 0) >= Number(item.quantity || 0));
        const lineSubtotal = money(refundItems.reduce((sum, item) => sum + item.lineSubtotal, 0));
        const lineCost = money(refundItems.reduce((sum, item) => sum + item.lineCost, 0));
        const originalSubtotal = Math.max(Number.EPSILON, Number(sale.subtotal || 0));
        let discount = money(Number(sale.discount || 0) * (lineSubtotal / originalSubtotal));
        const taxMode: TaxMode = sale.taxMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE";
        let totals = calculateTaxTotals(lineSubtotal, discount, Number(sale.taxRate || 0), taxMode, currency);

        if (isFinalRefund) {
          discount = money(Number(sale.discount || 0) - Number(sale.refundedDiscount || 0));
          totals = {
            ...calculateTaxTotals(lineSubtotal, discount, Number(sale.taxRate || 0), taxMode, currency),
            tax: money(Number(sale.tax || 0) - Number(sale.refundedTax || 0)),
            netSales: money(Number(sale.netSales ?? sale.total ?? 0) - Number(sale.refundedNetSales || 0)),
            total: money(Number(sale.total || 0) - Number(sale.refundedAmount || 0)),
          };
        }

        const remainingPoints = Math.max(0, Number(sale.pointsEarned || 0) - Number(sale.refundedPoints || 0));
        const pointsReversed = isFinalRefund
          ? remainingPoints
          : Math.min(remainingPoints, Math.max(0, Math.floor(Number(sale.pointsEarned || 0) * (totals.total / Math.max(Number.EPSILON, Number(sale.total || 0))))));
        const refundNo = makeDocumentNo("REF");
        const journalNo = makeDocumentNo("JE");
        const now = new Date();
        const tenderCurrency = String(sale.tenderCurrency || currency);
        const tenderTotal = quoteAmount(totals.total, Number(sale.exchangeRate || 1), tenderCurrency);
        refund = {
          _id: new ObjectId(),
          refundNo,
          ...(input.data.clientRequestId ? { clientRequestId: input.data.clientRequestId } : {}),
          saleId,
          receiptNo: sale.receiptNo,
          ...(counterId ? { counterId } : {}),
          ...(sale.locationId ? { locationId: sale.locationId } : {}),
          ...(openShift ? { shiftId: openShift._id, shiftNo: String(openShift.shiftNo) } : {}),
          reason: input.data.reason,
          items: refundItems,
          lineSubtotal,
          discount,
          taxRate: totals.taxRate,
          taxMode,
          tax: totals.tax,
          netSales: totals.netSales,
          total: totals.total,
          totalCost: lineCost,
          currency,
          paymentMethod: sale.paymentMethod,
          paymentMethodName: sale.paymentMethodName || sale.paymentMethod,
          paymentKind: sale.paymentKind === "CASH" ? "CASH" : "NON_CASH",
          tenderCurrency,
          tenderTotal,
          exchangeRate: Number(sale.exchangeRate || 1),
          pointsReversed,
          createdBy: new ObjectId(auth.session.id),
          createdByName: auth.session.fullName,
          createdAt: now,
        };

        await db.collection("refunds").insertOne(refund, { session: mongoSession });
        await writeOperationalReview(db, assessRefund({
          saleTotal: Number(sale.total || 0),
          refundTotal: totals.total,
          cumulativeRefundTotal: money(Number(sale.refundedAmount || 0) + totals.total),
        }), {
          sourceType: "refund",
          sourceId: String(refund._id),
          sourceNo: refundNo,
          sourceHref: `/receipts/${saleId.toHexString()}`,
          occurredAt: now,
          actor: auth.session,
          currency,
        }, mongoSession);
        for (const item of refundItems) {
          const product = await db.collection("products").findOne({ _id: item.productId }, { projection: { batchTracked: 1 }, session: mongoSession });
          if (product?.batchTracked && item.batchAllocations.reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0) !== item.quantity) {
            throw new BatchInventoryError(`${item.name} was sold before batch tracking was enabled. Record the returned lot in Batch control before posting this refund.`);
          }
          const locationTracked = await db.collection("inventoryBalances").findOne({ productId: item.productId }, { projection: { _id: 1 }, session: mongoSession });
          if (locationTracked) {
            if (!sale.locationId || !ObjectId.isValid(String(sale.locationId))) throw new InventoryLocationError(`${item.name} uses location inventory, but the original sale has no valid location.`);
            await db.collection("inventoryBalances").updateOne(
              { productId: item.productId, locationId: sale.locationId },
              {
                $inc: { quantity: item.quantity },
                $set: { sku: item.sku, productName: item.name, locationCode: String(sale.locationCode || ""), locationName: String(sale.locationName || "Sale location"), updatedAt: now },
                $setOnInsert: { _id: new ObjectId(), createdBy: new ObjectId(auth.session.id), createdAt: now },
              },
              { upsert: true, session: mongoSession },
            );
          }
          if (product?.batchTracked) {
            for (const allocation of item.batchAllocations) {
              await addInventoryBatchQuantity(db, {
                productId: item.productId,
                sku: item.sku,
                productName: item.name,
                locationId: sale.locationId as ObjectId,
                locationCode: String(sale.locationCode || ""),
                locationName: String(sale.locationName || "Sale location"),
                allocation,
                actorId: new ObjectId(auth.session.id),
                now,
              }, mongoSession);
            }
          }
          await db.collection("products").updateOne({ _id: item.productId }, { $inc: { stock: item.quantity }, $set: { updatedAt: now } }, { session: mongoSession });
          await db.collection("stockMovements").insertOne({
            productId: item.productId,
            sku: item.sku,
            productName: item.name,
            quantity: item.quantity,
            type: "RETURN",
            reason: refundNo,
            referenceId: refund._id,
            ...(counterId ? { counterId } : {}),
            ...(sale.locationId ? { locationId: sale.locationId } : {}),
            ...(sale.locationCode ? { locationCode: sale.locationCode } : {}),
            ...(sale.locationName ? { locationName: sale.locationName } : {}),
            ...(openShift ? { shiftId: openShift._id } : {}),
            createdBy: new ObjectId(auth.session.id),
            createdAt: now,
          }, { session: mongoSession });
        }

        const nextStatus = isFinalRefund ? "REFUNDED" : "PARTIALLY_REFUNDED";
        await db.collection("sales").updateOne(
          { _id: saleId },
          {
            $set: { items: updatedItems, status: nextStatus, updatedAt: now },
            $inc: {
              refundedAmount: totals.total,
              refundedDiscount: discount,
              refundedTax: totals.tax,
              refundedNetSales: totals.netSales,
              refundedCost: lineCost,
              refundedPoints: pointsReversed,
              refundedQuantityTotal: refundItems.reduce((sum, item) => sum + item.quantity, 0),
            },
          },
          { session: mongoSession },
        );

        if (sale.memberId) {
          await db.collection("members").updateOne(
            { _id: sale.memberId },
            [
              { $set: {
                points: { $max: [0, { $subtract: [{ $ifNull: ["$points", 0] }, pointsReversed] }] },
                lifetimeSpend: { $max: [0, { $subtract: [{ $ifNull: ["$lifetimeSpend", 0] }, totals.total] }] },
                updatedAt: now,
              } },
            ],
            { session: mongoSession },
          );
        }

        const paymentAccount = [String(sale.paymentAccountCode || (sale.paymentMethod === "CASH" ? "1000" : "1010")), String(sale.paymentAccountName || (sale.paymentMethod === "CASH" ? "Cash on hand" : "Bank"))];
        await db.collection("journalEntries").insertOne({
          entryNo: journalNo,
          date: now,
          memo: `POS refund ${refundNo} for ${sale.receiptNo}`,
          reference: refundNo,
          source: "POS_REFUND",
          ...(counterId ? { counterId } : {}),
          ...(sale.locationId ? { locationId: sale.locationId } : {}),
          ...(openShift ? { shiftId: openShift._id } : {}),
          status: "POSTED",
          lines: [
            { accountCode: "4000", accountName: "Product sales", debit: totals.netSales, credit: 0 },
            ...(totals.tax > 0 ? [{ accountCode: "2100", accountName: "Tax payable", debit: totals.tax, credit: 0 }] : []),
            { accountCode: paymentAccount[0], accountName: paymentAccount[1], debit: 0, credit: totals.total },
            { accountCode: "1200", accountName: "Inventory", debit: lineCost, credit: 0 },
            { accountCode: "5000", accountName: "Cost of goods sold", debit: 0, credit: lineCost },
          ],
          totalDebit: money(totals.total + lineCost),
          totalCredit: money(totals.total + lineCost),
          createdBy: new ObjectId(auth.session.id),
          createdAt: now,
        }, { session: mongoSession });
        await writeAudit(db, auth.session, "sale.refund", "sale", input.data.saleId, { refundNo, shiftNo: openShift?.shiftNo || "", total: totals.total, reason: input.data.reason }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise(refund));
  } catch (error) {
    if (error instanceof Error && error.message === "REFUND_NOT_AVAILABLE") return fail("This sale is not available for another refund.", 409);
    if (error instanceof Error && error.message === "REFUND_QUANTITY_INVALID") return fail("A refund quantity exceeds the number still returnable.", 422);
    if (error instanceof ShiftError) return fail(error.message, 409);
    if (error instanceof InventoryLocationError || error instanceof BatchInventoryError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000 && input.data.clientRequestId) {
      const db = await getDb();
      const existing = await db.collection("refunds").findOne({ clientRequestId: input.data.clientRequestId });
      if (existing) return ok(serialise(existing));
    }
    if ((error as { code?: number }).code === 11000) return fail("The refund number collided. Try the refund again.", 409);
    return publicError(error);
  }
}
