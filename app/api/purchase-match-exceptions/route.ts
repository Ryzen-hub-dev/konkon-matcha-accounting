import { ObjectId } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";
import { approvalRequiresDifferentMaker } from "@/lib/procurement";
import { purchaseMatchActionSchema } from "@/lib/purchase-matching";

export const runtime = "nodejs";

class PurchaseMatchConflictError extends Error {}

export async function PATCH(request: Request) {
  const auth = await authorize("purchasing.approve");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let body: unknown;
  try { body = await request.json(); }
  catch { return fail("The request body must be valid JSON.", 400); }
  const input = purchaseMatchActionSchema.safeParse(body);
  if (!input.success) return fail("Check the invoice-match decision.", 422, input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const client = await getMongoClient();
    const session = client.startSession();
    let result: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(async () => {
        const exception = await db.collection("purchaseMatchExceptions").findOne(
          { _id: new ObjectId(input.data.id), status: "PENDING", version: input.data.expectedVersion },
          { session },
        );
        if (!exception) throw new PurchaseMatchConflictError("This invoice variance changed or is no longer awaiting approval.");
        if (approvalRequiresDifferentMaker(auth.session.role) && String(exception.requestedBy) === auth.session.id) {
          throw new PurchaseMatchConflictError("A different authorised user must review this invoice variance.");
        }
        const now = new Date();
        const status = input.data.action === "APPROVE" ? "APPROVED" : "REJECTED";
        const updated = await db.collection("purchaseMatchExceptions").findOneAndUpdate(
          { _id: exception._id, status: "PENDING", version: input.data.expectedVersion },
          { $set: {
            status, reviewNote: input.data.note, reviewedBy: new ObjectId(auth.session.id),
            reviewedByName: auth.session.fullName, reviewedAt: now, updatedAt: now,
          }, $inc: { version: 1 } },
          { returnDocument: "after", session },
        );
        if (!updated) throw new PurchaseMatchConflictError("This invoice variance changed while it was being reviewed.");
        await writeAudit(db, auth.session, `purchase_match.${input.data.action.toLowerCase()}`, "purchaseMatchException", input.data.id, {
          purchaseOrderNo: exception.purchaseOrderNo, supplierInvoiceNo: exception.supplierInvoiceNo,
          expectedTotal: exception.expectedTotal, invoiceTotal: exception.invoiceTotal,
          expectedTax: exception.expectedTax, invoiceTax: exception.invoiceTax, currency: exception.currency,
          note: input.data.note,
        }, session);
        result = updated;
      });
    } finally { await session.endSession(); }
    return ok(serialise(result));
  } catch (error) {
    if (error instanceof PurchaseMatchConflictError) return fail(error.message, 409);
    return publicError(error);
  }
}
