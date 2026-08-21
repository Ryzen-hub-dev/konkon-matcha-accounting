import { ObjectId } from "mongodb";
import { authorize, created, fail, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { stocktakeDifference, stocktakeInputSchema } from "@/lib/stocktake";

export const runtime = "nodejs";

class StocktakeConflictError extends Error {}

export async function POST(request: Request) {
  const auth = await authorize("inventory.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);

  try {
    const input = stocktakeInputSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the stocktake counts.", 422, input.error.flatten().fieldErrors);

    const db = await getDb();
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    const stocktakeId = new ObjectId();
    const stocktakeNo = makeDocumentNo("STK");
    const now = new Date();
    let stocktake: Record<string, unknown> | null = null;

    try {
      await mongoSession.withTransaction(async () => {
        const ids = input.data.lines.map((line) => new ObjectId(line.productId));
        const products = await db.collection("products").find(
          { _id: { $in: ids }, active: { $ne: false } },
          { session: mongoSession },
        ).toArray();
        if (products.length !== ids.length) throw new StocktakeConflictError("One or more products are archived or no longer available.");

        const productMap = new Map(products.map((product) => [product._id.toHexString(), product]));
        const lines = input.data.lines.map((line) => {
          const product = productMap.get(line.productId)!;
          const bookStock = Number(product.stock || 0);
          const difference = stocktakeDifference(bookStock, line.countedStock);
          return {
            productId: product._id,
            sku: String(product.sku),
            barcode: String(product.barcode || ""),
            productName: String(product.name),
            unit: String(product.unit),
            bookStock,
            countedStock: line.countedStock,
            difference,
          };
        });

        for (const line of lines) {
          if (!line.difference) continue;
          const result = await db.collection("products").updateOne(
            { _id: line.productId, active: { $ne: false }, stock: line.bookStock },
            { $set: { stock: line.countedStock, updatedAt: now } },
            { session: mongoSession },
          );
          if (!result.modifiedCount) throw new StocktakeConflictError(`${line.productName} changed while the count was being posted. Reload and count it again.`);
        }

        const adjustedLines = lines.filter((line) => line.difference !== 0);
        if (adjustedLines.length) {
          await db.collection("stockMovements").insertMany(adjustedLines.map((line) => ({
            productId: line.productId,
            sku: line.sku,
            productName: line.productName,
            quantity: line.difference,
            type: "STOCKTAKE",
            reason: input.data.note || stocktakeNo,
            referenceId: stocktakeId,
            referenceNo: stocktakeNo,
            bookStock: line.bookStock,
            countedStock: line.countedStock,
            createdBy: new ObjectId(auth.session.id),
            createdAt: now,
          })), { session: mongoSession });
        }

        stocktake = {
          _id: stocktakeId,
          stocktakeNo,
          note: input.data.note,
          status: "POSTED",
          lines,
          lineCount: lines.length,
          adjustedLineCount: adjustedLines.length,
          absoluteVariance: adjustedLines.reduce((sum, line) => sum + Math.abs(line.difference), 0),
          createdBy: new ObjectId(auth.session.id),
          createdByName: auth.session.fullName,
          createdAt: now,
        };
        await db.collection("stocktakes").insertOne(stocktake, { session: mongoSession });
        await writeAudit(db, auth.session, "inventory.stocktake", "stocktake", stocktakeId.toHexString(), {
          stocktakeNo,
          lineCount: lines.length,
          adjustedLineCount: adjustedLines.length,
        }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }

    return created(serialise(stocktake));
  } catch (error) {
    if (error instanceof StocktakeConflictError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("The stocktake reference collided. Submit the count again.", 409);
    return publicError(error);
  }
}
