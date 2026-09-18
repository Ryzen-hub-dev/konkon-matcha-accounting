import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { DEFAULT_INVOICE_TEMPLATE, normaliseInvoiceTemplate } from "@/lib/invoice-templates";
import { calculateInvoiceAmounts } from "@/lib/invoices";
import {
  assertQuotationAction, assertQuotationVersion, nextQuotationUpdatedAt,
  quotationActionSchema, quotationEditSchema, quotationEffectiveStatus,
  quotationInputSchema, QuotationWorkflowError,
} from "@/lib/quotations";

export const runtime = "nodejs";

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

function withEffectiveStatus(quotation: Record<string, any>) {
  const today = dateKeyInTimeZone(new Date(), String(quotation.businessSnapshot?.timeZone || "UTC"));
  return { ...quotation, effectiveStatus: quotationEffectiveStatus(String(quotation.status), quotation.validUntil, today) };
}

export async function GET(request: Request) {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = new URL(request.url).searchParams.get("id") || "";
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The quotation reference is invalid.", 422);
      const quotation = await db.collection("quotations").findOne({ _id: new ObjectId(id) });
      return quotation ? ok(serialise(withEffectiveStatus(quotation))) : fail("This quotation could not be found.", 404);
    }
    const quotations = await db.collection("quotations").find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return ok(serialise(quotations.map(quotation => withEffectiveStatus(quotation))));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = quotationInputSchema.safeParse(body.value);
  if (!input.success) return fail("Check the quotation details.", 422, input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const result = await session.withTransaction(async () => {
        if (input.data.clientRequestId) {
          const existing = await db.collection("quotations").findOne({ clientRequestId: input.data.clientRequestId }, { session });
          if (existing) return { quotation: existing, isNew: false };
        }
        const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session }));
        const member = input.data.memberId
          ? await db.collection("members").findOne({ _id: new ObjectId(input.data.memberId), active: { $ne: false } }, { session })
          : null;
        if (input.data.memberId && !member) throw new QuotationWorkflowError("Choose an active customer account.", 422);
        const amounts = calculateInvoiceAmounts(input.data.items, business.currency, business.taxRate, business.taxMode);
        const now = new Date();
        const quotation = {
          _id: new ObjectId(), quotationNo: makeDocumentNo("QUO"),
          ...(input.data.clientRequestId ? { clientRequestId: input.data.clientRequestId } : {}),
          ...(member ? { memberId: member._id, memberNo: member.memberNo } : {}),
          customerName: input.data.customerName, customerEmail: input.data.customerEmail,
          customerPhone: input.data.customerPhone, customerAddress: input.data.customerAddress,
          customerReference: input.data.customerReference, validUntil: input.data.validUntil,
          notes: input.data.notes, ...amounts,
          businessSnapshot: {
            businessName: business.businessName, legalEntityName: business.legalEntityName,
            registrationNo: business.registrationNo, email: business.email, phone: business.phone,
            address: business.address, countryCode: business.countryCode, timeZone: business.timeZone,
            locale: business.locale, currency: business.currency, taxName: business.taxName,
            organizationType: business.organizationType, franchiseBrand: business.franchiseBrand,
            franchiseCode: business.franchiseCode,
          },
          status: "DRAFT", createdBy: new ObjectId(auth.session.id), createdAt: now, updatedAt: now,
        };
        await db.collection("quotations").insertOne(quotation, { session });
        await writeAudit(db, auth.session, "quotation.create", "quotation", quotation._id.toHexString(), { quotationNo: quotation.quotationNo, total: quotation.total, memberNo: member?.memberNo || null }, session);
        return { quotation, isNew: true };
      });
      return result.isNew ? created(serialise(withEffectiveStatus(result.quotation))) : ok(serialise(withEffectiveStatus(result.quotation)));
    } finally { await session.endSession(); }
  } catch (error) {
    if (input.data.clientRequestId && (error as { code?: number }).code === 11000) {
      const existing = await (await getDb()).collection("quotations").findOne({ clientRequestId: input.data.clientRequestId });
      if (existing) return ok(serialise(withEffectiveStatus(existing)));
    }
    if (error instanceof QuotationWorkflowError) return fail(error.message, error.status);
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
  const parsed = editing ? quotationEditSchema.safeParse(body.value) : quotationActionSchema.safeParse(body.value);
  if (!parsed.success) return fail(editing ? "Check the quotation draft." : "Check the quotation action.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const quotation = await session.withTransaction(async () => {
        const _id = new ObjectId(input.id);
        const current = await db.collection("quotations").findOne({ _id }, { session });
        if (!current) throw new QuotationWorkflowError("This quotation could not be found.", 404);
        if (!("items" in input) && input.action === "CONVERT" && current.status === "CONVERTED" && current.convertedInvoiceId) return current;
        assertQuotationVersion(current.updatedAt, input.expectedUpdatedAt);
        const updatedAt = nextQuotationUpdatedAt(current.updatedAt);
        const versionFilter = { _id, status: current.status, updatedAt: current.updatedAt };

        if ("items" in input) {
          if (current.status !== "DRAFT") throw new QuotationWorkflowError("Only a draft quotation can be edited.");
          const currency = String(current.businessSnapshot?.currency || "SGD");
          const amounts = calculateInvoiceAmounts(input.items, currency, Number(current.taxRate || 0), current.taxMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE");
          const member = input.memberId
            ? await db.collection("members").findOne({ _id: new ObjectId(input.memberId), active: { $ne: false } }, { session })
            : null;
          if (input.memberId && !member) throw new QuotationWorkflowError("Choose an active customer account.", 422);
          const changes: Record<string, unknown> = {
            customerName: input.customerName, customerEmail: input.customerEmail,
            customerPhone: input.customerPhone, customerAddress: input.customerAddress,
            customerReference: input.customerReference, validUntil: input.validUntil,
            notes: input.notes, ...amounts, updatedAt,
          };
          if (input.memberId !== undefined) { changes.memberId = member?._id || null; changes.memberNo = member?.memberNo || null; }
          const updated = await db.collection("quotations").findOneAndUpdate(versionFilter, { $set: changes }, { returnDocument: "after", session });
          if (!updated) throw new QuotationWorkflowError("This quotation changed. Refresh it before saving.");
          await writeAudit(db, auth.session, "quotation.edit", "quotation", input.id, { quotationNo: current.quotationNo, previousTotal: current.total, total: amounts.total }, session);
          return updated;
        }

        const timeZone = String(current.businessSnapshot?.timeZone || "UTC");
        const today = dateKeyInTimeZone(new Date(), timeZone);
        assertQuotationAction(String(current.status), input.action, current.validUntil, today);
        if (input.action === "CONVERT") {
          const template = await db.collection("invoiceTemplates").findOne({ isDefault: true, active: { $ne: false } }, { session });
          const templateSnapshot = normaliseInvoiceTemplate(template || DEFAULT_INVOICE_TEMPLATE);
          const invoice = {
            _id: new ObjectId(), invoiceNo: makeDocumentNo("INV"), sourceQuoteId: current._id, sourceQuoteNo: current.quotationNo,
            ...(current.memberId ? { memberId: current.memberId, memberNo: current.memberNo } : {}),
            customerName: current.customerName, customerEmail: current.customerEmail || "",
            customerPhone: current.customerPhone || "", customerAddress: current.customerAddress || "",
            customerReference: current.customerReference || "", dueDate: input.dueDate,
            notes: current.notes || "", templateId: template?._id || null,
            templateName: templateSnapshot.name, templateSnapshot,
            businessSnapshot: current.businessSnapshot,
            items: current.items, subtotal: current.subtotal, taxRate: current.taxRate,
            taxMode: current.taxMode, tax: current.tax, netSales: current.netSales, total: current.total,
            paidAmount: 0, status: "DRAFT", createdBy: new ObjectId(auth.session.id), createdAt: updatedAt, updatedAt,
          };
          await db.collection("invoices").insertOne(invoice, { session });
          const updated = await db.collection("quotations").findOneAndUpdate(
            versionFilter,
            { $set: { status: "CONVERTED", convertedInvoiceId: invoice._id, convertedInvoiceNo: invoice.invoiceNo, convertedAt: updatedAt, convertedBy: new ObjectId(auth.session.id), updatedAt } },
            { returnDocument: "after", session },
          );
          if (!updated) throw new QuotationWorkflowError("This quotation changed. Refresh it before converting.");
          await writeAudit(db, auth.session, "quotation.convert", "quotation", input.id, { quotationNo: current.quotationNo, invoiceNo: invoice.invoiceNo }, session);
          await writeAudit(db, auth.session, "invoice.create", "invoice", invoice._id.toHexString(), { invoiceNo: invoice.invoiceNo, total: invoice.total, sourceQuoteNo: current.quotationNo }, session);
          return updated;
        }

        const status = input.action === "MARK_SENT" ? "SENT" : input.action === "ACCEPT" ? "ACCEPTED" : input.action === "REJECT" ? "REJECTED" : "VOID";
        const eventFields = input.action === "MARK_SENT" ? { sentAt: updatedAt, sentBy: new ObjectId(auth.session.id) }
          : input.action === "ACCEPT" ? { acceptedAt: updatedAt, acceptedBy: new ObjectId(auth.session.id), acceptanceNote: input.note }
          : input.action === "REJECT" ? { rejectedAt: updatedAt, rejectedBy: new ObjectId(auth.session.id), rejectionReason: input.note }
          : { voidedAt: updatedAt, voidedBy: new ObjectId(auth.session.id), voidReason: input.note };
        const updated = await db.collection("quotations").findOneAndUpdate(versionFilter, { $set: { status, ...eventFields, updatedAt } }, { returnDocument: "after", session });
        if (!updated) throw new QuotationWorkflowError("This quotation changed. Refresh it before trying again.");
        await writeAudit(db, auth.session, `quotation.${input.action.toLowerCase()}`, "quotation", input.id, { quotationNo: current.quotationNo, previousStatus: current.status, status, note: input.note || null }, session);
        return updated;
      });
      return ok(serialise(withEffectiveStatus(quotation)));
    } finally { await session.endSession(); }
  } catch (error) {
    if (!editing && input.action === "CONVERT" && (error as { code?: number }).code === 11000) {
      const existing = await (await getDb()).collection("quotations").findOne({ _id: new ObjectId(input.id), status: "CONVERTED" });
      if (existing) return ok(serialise(withEffectiveStatus(existing)));
    }
    if (error instanceof QuotationWorkflowError) return fail(error.message, error.status);
    return publicError(error);
  }
}
