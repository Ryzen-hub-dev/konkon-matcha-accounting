import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { asMoney, makeDocumentNo, serialise } from "@/lib/format";
import { DEFAULT_INVOICE_TEMPLATE, normaliseInvoiceTemplate } from "@/lib/invoice-templates";

export const runtime = "nodejs";

const invoiceSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  customerEmail: z.union([z.string().trim().email(), z.literal("")]).default(""),
  customerPhone: z.string().trim().max(40).default(""),
  customerAddress: z.string().trim().max(300).default(""),
  customerReference: z.string().trim().max(80).default(""),
  dueDate: z.coerce.date(),
  notes: z.string().trim().max(500).default(""),
  templateId: z.union([z.string().length(24), z.literal("")]).default(""),
  items: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    quantity: z.coerce.number().positive().max(100_000),
    unitPrice: z.coerce.number().min(0).max(100_000_000),
  })).min(1).max(50),
});

const statusSchema = z.object({ id: z.string().length(24), status: z.enum(["DRAFT", "SENT", "PAID", "VOID"]) });

async function readBody(request: Request) {
  try {
    return { value: await request.json() } as const;
  } catch {
    return { error: fail("The request body must be valid JSON.", 400) } as const;
  }
}

export async function GET(request: Request) {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The invoice reference is invalid.", 422);
      const invoice = await db.collection("invoices").findOne({ _id: new ObjectId(id) });
      if (!invoice) return fail("This invoice could not be found.", 404);
      return ok(serialise(invoice));
    }
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
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = invoiceSchema.safeParse(body.value);
    if (!input.success) return fail("Check the invoice details.", 422, input.error.flatten().fieldErrors);
    const items = input.data.items.map((item) => ({ ...item, unitPrice: asMoney(item.unitPrice), lineTotal: asMoney(item.quantity * item.unitPrice) }));
    const db = await getDb();
    const subtotal = asMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
    const business = await db.collection("settings").findOne({ key: "business" });
    const requestedTemplate = input.data.templateId && ObjectId.isValid(input.data.templateId)
      ? await db.collection("invoiceTemplates").findOne({ _id: new ObjectId(input.data.templateId), active: { $ne: false } })
      : null;
    if (input.data.templateId && !requestedTemplate) return fail("Choose an available invoice template.", 422);
    const defaultTemplate = requestedTemplate || await db.collection("invoiceTemplates").findOne({ isDefault: true, active: { $ne: false } });
    const templateSnapshot = normaliseInvoiceTemplate(defaultTemplate || DEFAULT_INVOICE_TEMPLATE);
    const taxRate = Math.max(0, Math.min(100, Number(business?.taxRate || 0)));
    const tax = asMoney(subtotal * (taxRate / 100));
    const total = asMoney(subtotal + tax);
    const now = new Date();
    const document = {
      invoiceNo: makeDocumentNo("INV"),
      customerName: input.data.customerName,
      customerEmail: input.data.customerEmail,
      customerPhone: input.data.customerPhone,
      customerAddress: input.data.customerAddress,
      customerReference: input.data.customerReference,
      dueDate: input.data.dueDate,
      notes: input.data.notes,
      templateId: defaultTemplate?._id || null,
      templateName: templateSnapshot.name,
      templateSnapshot,
      businessSnapshot: {
        businessName: String(business?.businessName || "Kōn-Kōn Matchā"),
        registrationNo: String(business?.registrationNo || ""),
        email: String(business?.email || ""),
        phone: String(business?.phone || ""),
        address: String(business?.address || ""),
        currency: String(business?.currency || "SGD"),
        taxName: String(business?.taxName || "GST"),
      },
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
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = statusSchema.safeParse(body.value);
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
