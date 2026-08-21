import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { asMoney, makeDocumentNo, serialise } from "@/lib/format";
import { calculateTaxTotals, type TaxMode } from "@/lib/tax";

export const runtime = "nodejs";

const refundSchema = z.object({
  saleId: z.string().length(24),
  reason: z.string().trim().min(3).max(240),
  items: z.array(z.object({ productId: z.string().length(24), quantity: z.coerce.number().int().min(1).max(999) })).min(1).max(100),
});

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

        const saleItems = Array.isArray(sale.items) ? sale.items : [];
        const itemMap = new Map(saleItems.map((item) => [item.productId.toString(), item]));
        for (const [productId, quantity] of requested) {
          const item = itemMap.get(productId);
          const remaining = Number(item?.quantity || 0) - Number(item?.refundedQuantity || 0);
          if (!item || quantity > remaining) throw new Error("REFUND_QUANTITY_INVALID");
        }

        const refundItems = [...requested.entries()].map(([productId, quantity]) => {
          const item = itemMap.get(productId)!;
          return {
            productId: item.productId,
            sku: String(item.sku || ""),
            name: String(item.name),
            quantity,
            price: asMoney(item.price),
            cost: asMoney(item.cost),
            lineSubtotal: asMoney(Number(item.price) * quantity),
            lineCost: asMoney(Number(item.cost) * quantity),
          };
        });

        const updatedItems = saleItems.map((item) => {
          const refundQuantity = requested.get(item.productId.toString()) || 0;
          return refundQuantity ? {
            ...item,
            refundedQuantity: Number(item.refundedQuantity || 0) + refundQuantity,
            refundedLineTotal: asMoney(Number(item.refundedLineTotal || 0) + Number(item.price) * refundQuantity),
          } : item;
        });
        const isFinalRefund = updatedItems.every((item) => Number(item.refundedQuantity || 0) >= Number(item.quantity || 0));
        const lineSubtotal = asMoney(refundItems.reduce((sum, item) => sum + item.lineSubtotal, 0));
        const lineCost = asMoney(refundItems.reduce((sum, item) => sum + item.lineCost, 0));
        const originalSubtotal = Math.max(0.01, Number(sale.subtotal || 0));
        let discount = asMoney(Number(sale.discount || 0) * (lineSubtotal / originalSubtotal));
        const taxMode: TaxMode = sale.taxMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE";
        let totals = calculateTaxTotals(lineSubtotal, discount, Number(sale.taxRate || 0), taxMode);

        if (isFinalRefund) {
          discount = asMoney(Number(sale.discount || 0) - Number(sale.refundedDiscount || 0));
          totals = {
            ...calculateTaxTotals(lineSubtotal, discount, Number(sale.taxRate || 0), taxMode),
            tax: asMoney(Number(sale.tax || 0) - Number(sale.refundedTax || 0)),
            netSales: asMoney(Number(sale.netSales ?? sale.total ?? 0) - Number(sale.refundedNetSales || 0)),
            total: asMoney(Number(sale.total || 0) - Number(sale.refundedAmount || 0)),
          };
        }

        const remainingPoints = Math.max(0, Number(sale.pointsEarned || 0) - Number(sale.refundedPoints || 0));
        const pointsReversed = isFinalRefund
          ? remainingPoints
          : Math.min(remainingPoints, Math.max(0, Math.floor(Number(sale.pointsEarned || 0) * (totals.total / Math.max(0.01, Number(sale.total || 0))))));
        const refundNo = makeDocumentNo("REF");
        const journalNo = makeDocumentNo("JE");
        const now = new Date();
        refund = {
          _id: new ObjectId(),
          refundNo,
          saleId,
          receiptNo: sale.receiptNo,
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
          paymentMethod: sale.paymentMethod,
          paymentMethodName: sale.paymentMethodName || sale.paymentMethod,
          pointsReversed,
          createdBy: new ObjectId(auth.session.id),
          createdByName: auth.session.fullName,
          createdAt: now,
        };

        await db.collection("refunds").insertOne(refund, { session: mongoSession });
        for (const item of refundItems) {
          await db.collection("products").updateOne({ _id: item.productId }, { $inc: { stock: item.quantity }, $set: { updatedAt: now } }, { session: mongoSession });
          await db.collection("stockMovements").insertOne({
            productId: item.productId,
            sku: item.sku,
            productName: item.name,
            quantity: item.quantity,
            type: "RETURN",
            reason: refundNo,
            referenceId: refund._id,
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
          status: "POSTED",
          lines: [
            { accountCode: "4000", accountName: "Product sales", debit: totals.netSales, credit: 0 },
            ...(totals.tax > 0 ? [{ accountCode: "2100", accountName: "GST payable", debit: totals.tax, credit: 0 }] : []),
            { accountCode: paymentAccount[0], accountName: paymentAccount[1], debit: 0, credit: totals.total },
            { accountCode: "1200", accountName: "Inventory", debit: lineCost, credit: 0 },
            { accountCode: "5000", accountName: "Cost of goods sold", debit: 0, credit: lineCost },
          ],
          totalDebit: asMoney(totals.total + lineCost),
          totalCredit: asMoney(totals.total + lineCost),
          createdBy: new ObjectId(auth.session.id),
          createdAt: now,
        }, { session: mongoSession });
        await writeAudit(db, auth.session, "sale.refund", "sale", input.data.saleId, { refundNo, total: totals.total, reason: input.data.reason }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise(refund));
  } catch (error) {
    if (error instanceof Error && error.message === "REFUND_NOT_AVAILABLE") return fail("This sale is not available for another refund.", 409);
    if (error instanceof Error && error.message === "REFUND_QUANTITY_INVALID") return fail("A refund quantity exceeds the number still returnable.", 422);
    if ((error as { code?: number }).code === 11000) return fail("The refund number collided. Try the refund again.", 409);
    return publicError(error);
  }
}
