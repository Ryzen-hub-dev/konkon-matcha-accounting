import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { asMoney, makeDocumentNo, serialise } from "@/lib/format";

export const runtime = "nodejs";

const saleSchema = z.object({
  memberId: z.union([z.string().length(24), z.literal(""), z.null()]).optional(),
  paymentMethod: z.enum(["CASH", "CARD", "PAYNOW", "OTHER"]),
  discount: z.coerce.number().min(0).max(100_000).default(0),
  items: z.array(z.object({
    productId: z.string().length(24),
    quantity: z.coerce.number().int().min(1).max(999),
  })).min(1).max(100),
});

class StockError extends Error {}

export async function GET() {
  const auth = await authorize("reports.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const sales = await db.collection("sales").find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return ok(serialise(sales));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = saleSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the sale details.", 422, input.error.flatten().fieldErrors);
    const quantities = new Map<string, number>();
    for (const item of input.data.items) {
      if (!ObjectId.isValid(item.productId)) return fail("A product in the cart is invalid.", 422);
      quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
    }

    const db = await getDb();
    const ids = [...quantities.keys()].map((id) => new ObjectId(id));
    const products = await db.collection("products").find({ _id: { $in: ids }, active: { $ne: false } }).toArray();
    if (products.length !== ids.length) return fail("One or more products are no longer available.", 409);
    const productMap = new Map(products.map((product) => [product._id.toHexString(), product]));
    const items = [...quantities.entries()].map(([productId, quantity]) => {
      const product = productMap.get(productId)!;
      const price = asMoney(product.price);
      const cost = asMoney(product.cost);
      return {
        productId: product._id,
        sku: String(product.sku),
        name: String(product.name),
        quantity,
        price,
        cost,
        lineTotal: asMoney(price * quantity),
        lineCost: asMoney(cost * quantity),
      };
    });
    const subtotal = asMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
    const discount = asMoney(input.data.discount);
    if (discount > subtotal) return fail("Discount cannot exceed the subtotal.", 422);
    const business = await db.collection("settings").findOne({ key: "business" });
    const taxRate = Math.max(0, Math.min(100, Number(business?.taxRate || 0)));
    const taxable = asMoney(subtotal - discount);
    const tax = asMoney(taxable * (taxRate / 100));
    const total = asMoney(taxable + tax);
    const totalCost = asMoney(items.reduce((sum, item) => sum + item.lineCost, 0));
    const receiptNo = makeDocumentNo("KKM");
    const journalNo = makeDocumentNo("JE");
    const now = new Date();
    let member = null;
    if (input.data.memberId) {
      member = await db.collection("members").findOne({ _id: new ObjectId(input.data.memberId), active: { $ne: false } });
      if (!member) return fail("The selected member no longer exists.", 409);
    }

    const saleId = new ObjectId();
    const sale = {
      _id: saleId,
      receiptNo,
      memberId: member?._id || null,
      memberName: member?.name || "Walk-in guest",
      items,
      subtotal,
      discount,
      taxRate,
      tax,
      netSales: taxable,
      total,
      totalCost,
      paymentMethod: input.data.paymentMethod,
      status: "COMPLETED",
      createdBy: new ObjectId(auth.session.id),
      cashierName: auth.session.fullName,
      createdAt: now,
    };

    const client = await getMongoClient();
    const mongoSession = client.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        for (const item of items) {
          const updated = await db.collection("products").findOneAndUpdate(
            { _id: item.productId, active: { $ne: false }, stock: { $gte: item.quantity } },
            { $inc: { stock: -item.quantity }, $set: { updatedAt: now } },
            { returnDocument: "after", session: mongoSession },
          );
          if (!updated) throw new StockError(`${item.name} does not have enough stock.`);
          await db.collection("stockMovements").insertOne({
            productId: item.productId,
            sku: item.sku,
            productName: item.name,
            quantity: -item.quantity,
            type: "SALE",
            reason: receiptNo,
            referenceId: saleId,
            createdBy: new ObjectId(auth.session.id),
            createdAt: now,
          }, { session: mongoSession });
        }
        await db.collection("sales").insertOne(sale, { session: mongoSession });
        if (member) {
          const pointsEarned = Math.max(0, Math.floor(total * Number(business?.pointsPerDollar || 1)));
          await db.collection("members").updateOne(
            { _id: member._id },
            { $inc: { points: pointsEarned, lifetimeSpend: total }, $set: { lastVisitAt: now, updatedAt: now } },
            { session: mongoSession },
          );
        }
        const cashAccount = input.data.paymentMethod === "CASH" ? ["1000", "Cash on hand"] : ["1010", "Bank"];
        const revenueLines = [
          { accountCode: "4000", accountName: "Product sales", debit: 0, credit: taxable },
          ...(tax > 0 ? [{ accountCode: "2100", accountName: "GST payable", debit: 0, credit: tax }] : []),
        ];
        await db.collection("journalEntries").insertOne({
          entryNo: journalNo,
          date: now,
          memo: `POS sale ${receiptNo}`,
          reference: receiptNo,
          source: "POS",
          status: "POSTED",
          lines: [
            { accountCode: cashAccount[0], accountName: cashAccount[1], debit: total, credit: 0 },
            ...revenueLines,
            { accountCode: "5000", accountName: "Cost of goods sold", debit: totalCost, credit: 0 },
            { accountCode: "1200", accountName: "Inventory", debit: 0, credit: totalCost },
          ],
          totalDebit: asMoney(total + totalCost),
          totalCredit: asMoney(total + totalCost),
          createdBy: new ObjectId(auth.session.id),
          createdAt: now,
        }, { session: mongoSession });
        await writeAudit(db, auth.session, "sale.complete", "sale", saleId.toHexString(), { receiptNo, total, itemCount: items.length }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise(sale));
  } catch (error) {
    if (error instanceof StockError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("The receipt number collided. Please submit the sale again.", 409);
    return publicError(error);
  }
}
