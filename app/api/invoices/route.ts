import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { AccountingPeriodClosedError } from "@/lib/accounting-periods";
import { assertAccountingPeriodOpen } from "@/lib/accounting-period-lock";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { DEFAULT_INVOICE_TEMPLATE, normaliseInvoiceTemplate } from "@/lib/invoice-templates";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { evaluateCustomerCredit } from "@/lib/customer-accounts";
import { applyDocumentDimensions, DimensionSelectionError, resolveDocumentDimensionSelection } from "@/lib/dimension-selection";
import { roundCurrency } from "@/lib/international";
import { dateKeyInTimeZone } from "@/lib/dates";
import {
  assertInvoiceDraftEditable, assertInvoiceStatusTransition, assertInvoiceVersion,
  calculateInvoiceAmounts, invoiceEditSchema, invoiceInputSchema, invoiceStatusSchema,
  InvoiceWorkflowError, nextInvoiceUpdatedAt,
} from "@/lib/invoices";

export const runtime = "nodejs";

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
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
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = invoiceInputSchema.safeParse(body.value);
  if (!input.success) return fail("Check the invoice details.", 422, input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    try {
      const result = await mongoSession.withTransaction(async () => {
        if (input.data.clientRequestId) {
          const existing = await db.collection("invoices").findOne({ clientRequestId: input.data.clientRequestId }, { session: mongoSession });
          if (existing) return { invoice: existing, isNew: false };
        }
        const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session: mongoSession }));
        const amounts = calculateInvoiceAmounts(input.data.items, business.currency, business.taxRate, business.taxMode);
        const member = input.data.memberId
          ? await db.collection("members").findOne({ _id: new ObjectId(input.data.memberId), active: { $ne: false } }, { session: mongoSession })
          : null;
        if (input.data.memberId && !member) throw new InvoiceWorkflowError("Choose an active customer account.", 422);
        const requestedTemplate = input.data.templateId
          ? await db.collection("invoiceTemplates").findOne({ _id: new ObjectId(input.data.templateId), active: { $ne: false } }, { session: mongoSession })
          : null;
        if (input.data.templateId && !requestedTemplate) throw new InvoiceWorkflowError("Choose an available invoice template.", 422);
        const defaultTemplate = requestedTemplate || await db.collection("invoiceTemplates").findOne({ isDefault: true, active: { $ne: false } }, { session: mongoSession });
        const templateSnapshot = normaliseInvoiceTemplate(defaultTemplate || DEFAULT_INVOICE_TEMPLATE);
        const now = new Date();
        const dimensionSelection = await resolveDocumentDimensionSelection(db, input.data.dimensionSelection, member, mongoSession, now);
        const document = {
          _id: new ObjectId(),
          invoiceNo: makeDocumentNo("INV"),
          ...(input.data.clientRequestId ? { clientRequestId: input.data.clientRequestId } : {}),
          ...(member ? { memberId: member._id, memberNo: member.memberNo } : {}),
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
          dimensionSelection,
          businessSnapshot: {
            businessName: business.businessName, legalEntityName: business.legalEntityName,
            registrationNo: business.registrationNo, email: business.email, phone: business.phone,
            address: business.address, countryCode: business.countryCode, timeZone: business.timeZone,
            locale: business.locale, currency: business.currency, taxName: business.taxName,
            organizationType: business.organizationType, franchiseBrand: business.franchiseBrand,
            franchiseCode: business.franchiseCode,
          },
          ...amounts,
          paidAmount: 0, status: "DRAFT",
          createdBy: new ObjectId(auth.session.id), createdAt: now, updatedAt: now,
        };
        await db.collection("invoices").insertOne(document, { session: mongoSession });
        await writeAudit(db, auth.session, "invoice.create", "invoice", document._id.toHexString(), { invoiceNo: document.invoiceNo, total: document.total, memberNo: member?.memberNo || null, dimensionMode: dimensionSelection.mode, costCentreCode: dimensionSelection.costCentre?.code || "", projectCode: dimensionSelection.project?.code || "" }, mongoSession);
        return { invoice: document, isNew: true };
      });
      return result.isNew ? created(serialise(result.invoice)) : ok(serialise(result.invoice));
    } finally { await mongoSession.endSession(); }
  } catch (error) {
    // Concurrent requests can both miss the initial read. The unique index is the final guard.
    if (input.data.clientRequestId && typeof error === "object" && error && "code" in error && error.code === 11000) {
      try {
        const existing = await (await getDb()).collection("invoices").findOne({ clientRequestId: input.data.clientRequestId });
        if (existing) return ok(serialise(existing));
      } catch (lookupError) { return publicError(lookupError); }
    }
    if (error instanceof InvoiceWorkflowError) return fail(error.message, error.status);
    if (error instanceof DimensionSelectionError) return fail(error.message, 422);
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
  const parsed = editing ? invoiceEditSchema.safeParse(body.value) : invoiceStatusSchema.safeParse(body.value);
  if (!parsed.success) return fail(editing ? "Check the draft details." : "Check the invoice status.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  try {
    const db = await getDb();
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    try {
      const invoice = await mongoSession.withTransaction(async () => {
        const _id = new ObjectId(input.id);
        // Read inside the transaction: payment must never post totals from a stale draft.
        const current = await db.collection("invoices").findOne({ _id }, { session: mongoSession });
        if (!current) throw new InvoiceWorkflowError("This invoice could not be found.", 404);
        assertInvoiceVersion(current.updatedAt, input.expectedUpdatedAt);
        const currency = String(current.businessSnapshot?.currency || "SGD");
        const versionFilter = { _id, status: current.status, updatedAt: current.updatedAt ?? { $exists: false } };
        const updatedAt = nextInvoiceUpdatedAt(current.updatedAt);

        if ("action" in input) {
          assertInvoiceDraftEditable({ status: current.status, paidAmount: current.paidAmount });
          const amounts = calculateInvoiceAmounts(input.items, currency, Number(current.taxRate || 0), current.taxMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE");
          const member = input.memberId
            ? await db.collection("members").findOne({ _id: new ObjectId(input.memberId), active: { $ne: false } }, { session: mongoSession })
            : null;
          if (input.memberId && !member) throw new InvoiceWorkflowError("Choose an active customer account.", 422);
          const dimensionSelection = input.dimensionSelection
            ? await resolveDocumentDimensionSelection(db, input.dimensionSelection, member, mongoSession, updatedAt)
            : current.dimensionSelection || { mode: "NONE", source: "EXPLICIT_NONE", resolvedAt: updatedAt };
          const changes: Record<string, unknown> = {
            customerName: input.customerName, customerEmail: input.customerEmail,
            customerPhone: input.customerPhone, customerAddress: input.customerAddress,
            customerReference: input.customerReference, dueDate: input.dueDate, notes: input.notes,
            dimensionSelection, ...amounts, updatedAt,
          };
          if (input.memberId !== undefined) {
            changes.memberId = member?._id || null;
            changes.memberNo = member?.memberNo || null;
          }
          if (input.templateId !== String(current.templateId || "")) {
            const template = await db.collection("invoiceTemplates").findOne(
              input.templateId ? { _id: new ObjectId(input.templateId), active: { $ne: false } } : { isDefault: true, active: { $ne: false } },
              { session: mongoSession },
            );
            if (input.templateId && !template) throw new InvoiceWorkflowError("Choose an available invoice template.", 422);
            const snapshot = normaliseInvoiceTemplate(template || DEFAULT_INVOICE_TEMPLATE);
            changes.templateId = template?._id || null;
            changes.templateName = snapshot.name;
            changes.templateSnapshot = snapshot;
          }
          const updated = await db.collection("invoices").findOneAndUpdate(versionFilter, { $set: changes }, { returnDocument: "after", session: mongoSession });
          if (!updated) throw new InvoiceWorkflowError("This invoice changed. Refresh it before saving.");
          await writeAudit(db, auth.session, "invoice.edit", "invoice", input.id, {
            invoiceNo: current.invoiceNo, previousTotal: current.total, total: amounts.total,
            previousUpdatedAt: current.updatedAt, templateChanged: "templateSnapshot" in changes,
            dimensionMode: dimensionSelection.mode, costCentreCode: dimensionSelection.costCentre?.code || "", projectCode: dimensionSelection.project?.code || "",
          }, mongoSession);
          return updated;
        }

        assertInvoiceStatusTransition({ status: current.status, paidAmount: current.paidAmount }, input.status);
        if (input.status === current.status) return current;
        const paymentFields = input.status === "PAID" ? { paidAmount: current.total, paidAt: updatedAt } : {};
        let creditFields: Record<string, unknown> = {};
        if (input.status === "SENT") {
          creditFields = { sentAt: updatedAt };
          if (current.memberId) {
            const memberId = current.memberId instanceof ObjectId ? current.memberId : new ObjectId(String(current.memberId));
            const member = await db.collection("members").findOne({ _id: memberId, active: { $ne: false } }, { session: mongoSession });
            if (!member) throw new InvoiceWorkflowError("This linked customer account is no longer active. Reopen the draft and choose an active account.", 409);
            const exposure = await db.collection("invoices").aggregate([
              { $match: {
                _id: { $ne: _id }, memberId, status: "SENT",
                $or: [{ "businessSnapshot.currency": currency }, { "businessSnapshot.currency": { $exists: false } }],
              } },
              { $group: { _id: null, outstanding: { $sum: { $subtract: ["$total", { $ifNull: ["$paidAmount", 0] }] } } } },
            ], { session: mongoSession }).next();
            const outstandingBefore = roundCurrency(Number(exposure?.outstanding || 0), currency);
            const creditLimit = member.creditLimit === null || member.creditLimit === undefined ? null : Number(member.creditLimit);
            const decision = evaluateCustomerCredit({
              creditHold: member.creditHold === true,
              creditLimit,
              outstanding: outstandingBefore,
              newCharge: Number(current.total),
              currency,
            });
            if (!decision.allowed) throw new InvoiceWorkflowError(decision.reason || "This invoice is outside the customer's credit controls.", 409);
            // Touch the shared account inside this transaction. Concurrent sends for
            // the same customer then conflict and withTransaction retries the full
            // exposure calculation instead of allowing a credit-limit write skew.
            await db.collection("members").updateOne(
              { _id: memberId, active: { $ne: false } },
              { $set: { creditExposureCheckedAt: updatedAt } },
              { session: mongoSession },
            );
            creditFields.creditAccountSnapshot = {
              memberId, memberNo: member.memberNo, name: member.name,
              creditLimit, creditTermsDays: Number(member.creditTermsDays ?? 14),
              outstandingBefore, projectedOutstanding: decision.projectedOutstanding, checkedAt: updatedAt,
            };
          }
        }
        const postingTimeZone = String(current.businessSnapshot?.timeZone || "UTC");
        const postingDateKey = dateKeyInTimeZone(updatedAt, postingTimeZone);
        if (input.status === "PAID") await assertAccountingPeriodOpen(db, postingDateKey, mongoSession);
        const updated = await db.collection("invoices").findOneAndUpdate(
          versionFilter, { $set: { status: input.status, ...paymentFields, ...creditFields, updatedAt } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!updated) throw new InvoiceWorkflowError("This invoice changed. Refresh it before trying again.");
        if (input.status === "PAID") {
          const tax = Number(current.tax || 0);
          await db.collection("journalEntries").insertOne({
            entryNo: makeDocumentNo("JE"), date: updatedAt, businessDate: postingDateKey, timeZone: postingTimeZone, memo: "Invoice payment " + current.invoiceNo,
            reference: current.invoiceNo, source: "INVOICE", status: "POSTED",
            lines: applyDocumentDimensions([
              { accountCode: "1010", accountName: "Bank", debit: current.total, credit: 0 },
              { accountCode: "4000", accountName: "Product sales", debit: 0, credit: Number(current.netSales ?? roundCurrency(Number(current.total) - tax, currency)) },
              ...(tax > 0 ? [{ accountCode: "2100", accountName: "Tax payable", debit: 0, credit: tax }] : []),
            ], current.dimensionSelection),
            totalDebit: current.total, totalCredit: current.total,
            createdBy: new ObjectId(auth.session.id), createdAt: updatedAt,
          }, { session: mongoSession });
          await writeAudit(db, auth.session, "invoice.paid", "invoice", input.id, { invoiceNo: current.invoiceNo, total: current.total, dimensionMode: current.dimensionSelection?.mode || "LEGACY_NONE", costCentreCode: current.dimensionSelection?.costCentre?.code || "", projectCode: current.dimensionSelection?.project?.code || "" }, mongoSession);
        } else {
          await writeAudit(db, auth.session, "invoice.status", "invoice", input.id, {
            previousStatus: current.status,
            status: input.status,
            creditCheck: creditFields.creditAccountSnapshot || null,
          }, mongoSession);
        }
        return updated;
      });
      return ok(serialise(invoice));
    } finally { await mongoSession.endSession(); }
  } catch (error) {
    if (error instanceof AccountingPeriodClosedError) return fail(error.message, error.status);
    if (error instanceof InvoiceWorkflowError) return fail(error.message, error.status);
    if (error instanceof DimensionSelectionError) return fail(error.message, 422);
    return publicError(error);
  }
}
