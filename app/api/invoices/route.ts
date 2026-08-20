import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { asMoney, makeDocumentNo, serialise } from "@/lib/format";

export const runtime = "nodejs";

const invoiceSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  customerEmail: z.union([z.string().trim().email(), z.literal("")]).default(""),
  dueDate: z.coerce.date(),
  notes: z.string().trim().max(500).default(""),
  items: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    quantity: z.coerce.number().positive().max(100_000),
    unitPrice: z.coerce.number().min(0).max(100_000_000),
  })).min(1).max(50),
});

const statusSchema = z.object({ id: z.string().length(24), status: z.enum(["DRAFT", "SENT", "PAID", "VOID"]) });

export async function GET() {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const invoices = await db.collection("invoices").find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return ok(serialise(invoices));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = invoiceSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the invoice details.", 422, input.error.flatten().fieldErrors);
    const items = input.data.items.map((item) => ({ ...item, unitPrice: asMoney(item.unitPrice), lineTotal: asMoney(item.quantity * item.unitPrice) }));
    const db = await getDb();
    const subtotal = asMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
    const business = await db.collection("settings").findOne({ key: "business" });
    const taxRate = Math.max(0, Math.min(100, Number(business?.taxRate || 0)));
    const tax = asMoney(subtotal * (taxRate / 100));
    const total = asMoney(subtotal + tax);
    const now = new Date();
    const document = {
      invoiceNo: makeDocumentNo("INV"),
      customerName: input.data.customerName,
      customerEmail: input.data.customerEmail,
      dueDate: input.data.dueDate,
      notes: input.data.notes,
      items,
      subtotal,
      taxRate,
      tax,
      total,
      paidAmount: 0,
      status: "DRAFT",
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("invoices").insertOne(document);
    await writeAudit(db, auth.session, "invoice.create", "invoice", result.insertedId.toHexString(), { invoiceNo: document.invoiceNo, total });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = statusSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the invoice status.", 422);
    const db = await getDb();
    const _id = new ObjectId(input.data.id);
    const current = await db.collection("invoices").findOne({ _id });
    if (!current || current.status === "VOID") return fail("The invoice no longer exists or is already void.", 409);
    if (current.status === "PAID" && input.data.status !== "PAID") return fail("A paid invoice cannot be reopened. Create a reversing journal if needed.", 409);
    let invoice = current;
    if (input.data.status === "PAID" && current.status !== "PAID") {
      const client = await getMongoClient();
      const mongoSession = client.startSession();
      try {
        await mongoSession.withTransaction(async () => {
          const paidAt = new Date();
          const updated = await db.collection("invoices").findOneAndUpdate(
            { _id, status: current.status },
            { $set: { status: "PAID", paidAmount: current.total, paidAt, updatedAt: paidAt } },
            { returnDocument: "after", session: mongoSession },
          );
          if (!updated) throw new Error("Invoice status changed while payment was being posted.");
          invoice = updated;
          const tax = Number(current.tax || 0);
          await db.collection("journalEntries").insertOne({
            entryNo: makeDocumentNo("JE"), date: paidAt, memo: `Invoice payment ${current.invoiceNo}`,
            reference: current.invoiceNo, source: "INVOICE", status: "POSTED",
            lines: [
              { accountCode: "1010", accountName: "Bank", debit: current.total, credit: 0 },
              { accountCode: "4000", accountName: "Product sales", debit: 0, credit: current.subtotal },
              ...(tax > 0 ? [{ accountCode: "2100", accountName: "GST payable", debit: 0, credit: tax }] : []),
            ],
            totalDebit: current.total, totalCredit: current.total,
            createdBy: new ObjectId(auth.session.id), createdAt: paidAt,
          }, { session: mongoSession });
          await writeAudit(db, auth.session, "invoice.paid", "invoice", input.data.id, { invoiceNo: current.invoiceNo, total: current.total }, mongoSession);
        });
      } finally { await mongoSession.endSession(); }
    } else if (input.data.status !== current.status) {
      const updated = await db.collection("invoices").findOneAndUpdate({ _id, status: current.status }, { $set: { status: input.data.status, updatedAt: new Date() } }, { returnDocument: "after" });
      if (!updated) return fail("Invoice status changed. Refresh and try again.", 409);
      invoice = updated;
      await writeAudit(db, auth.session, "invoice.status", "invoice", input.data.id, { status: input.data.status });
    }
    return ok(serialise(invoice));
  } catch (error) {
    return publicError(error);
  }
}
