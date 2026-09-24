import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { resolveDocumentDimensionSelection, DimensionSelectionError } from "@/lib/dimension-selection";
import { makeDocumentNo, serialise } from "@/lib/format";
import { generateDueRecurringInvoices } from "@/lib/recurring-invoice-generator";
import {
  assertRecurringInvoiceAction, assertRecurringInvoiceVersion, recurringInvoiceActionSchema,
  recurringInvoiceInputSchema, recurringScheduleObjectId, RecurringInvoiceError,
} from "@/lib/recurring-invoices";
import { calculateInvoiceAmounts, nextInvoiceUpdatedAt } from "@/lib/invoices";

export const runtime = "nodejs";
export const maxDuration = 30;

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

export async function GET() {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [schedules, accounts, templates, dimensions] = await Promise.all([
      db.collection("recurringInvoices").find({}).sort({ createdAt: -1 }).limit(200).toArray(),
      db.collection("members").find({ active: { $ne: false } }).project({ memberNo: 1, name: 1, email: 1, phone: 1, creditTermsDays: 1, dimensionDefaults: 1 }).sort({ name: 1 }).limit(500).toArray(),
      db.collection("invoiceTemplates").find({ active: { $ne: false } }).project({ name: 1, isDefault: 1 }).sort({ isDefault: -1, name: 1 }).toArray(),
      db.collection("accountingDimensions").find({ active: { $ne: false } }).project({ type: 1, code: 1, name: 1 }).sort({ type: 1, code: 1 }).limit(500).toArray(),
    ]);
    return ok(serialise({ schedules, accounts, templates, dimensions }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("invoices.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = recurringInvoiceInputSchema.safeParse(body.value);
  if (!input.success) return fail("Check the recurring invoice details.", 422, input.error.flatten().fieldErrors);
  const id = new ObjectId(recurringScheduleObjectId(input.data.clientRequestId));
  try {
    const db = await getDb();
    const client = await getMongoClient();
    const session = client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const existing = await db.collection("recurringInvoices").findOne({ _id: id }, { session });
        if (existing) {
          if (existing.clientRequestId !== input.data.clientRequestId) throw new RecurringInvoiceError("This request reference is already in use.");
          return { schedule: existing, isNew: false };
        }
        const member = await db.collection("members").findOne({ _id: new ObjectId(input.data.memberId), active: { $ne: false } }, { session });
        if (!member) throw new RecurringInvoiceError("Choose an active customer account.", 422);
        const template = input.data.templateId
          ? await db.collection("invoiceTemplates").findOne({ _id: new ObjectId(input.data.templateId), active: { $ne: false } }, { session })
          : null;
        if (input.data.templateId && !template) throw new RecurringInvoiceError("Choose an available invoice template.", 422);
        await resolveDocumentDimensionSelection(db, input.data.dimensionSelection, member, session);
        const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session }));
        const amounts = calculateInvoiceAmounts(input.data.items, business.currency, business.taxRate, business.taxMode);
        const now = new Date();
        const schedule = {
          _id: id,
          scheduleNo: makeDocumentNo("REC"),
          clientRequestId: input.data.clientRequestId,
          name: input.data.name,
          status: "ACTIVE",
          memberId: member._id,
          memberNo: member.memberNo,
          customerName: member.name,
          customerEmail: member.email || "",
          customerPhone: member.phone || "",
          billingAddress: input.data.billingAddress,
          customerReference: input.data.customerReference,
          notes: input.data.notes,
          templateId: template?._id || null,
          templateName: template?.name || "Default invoice template",
          dimensionSelectionInput: input.data.dimensionSelection,
          items: amounts.items.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })),
          plannedSubtotal: amounts.subtotal,
          plannedTax: amounts.tax,
          plannedTotal: amounts.total,
          plannedCurrency: business.currency,
          frequency: input.data.frequency,
          startDate: input.data.startDate,
          nextRunDate: input.data.startDate,
          endDate: input.data.endDate,
          dueDays: input.data.dueDays,
          anchorDay: Number(input.data.startDate.slice(8, 10)),
          createdBy: new ObjectId(auth.session.id),
          createdByName: auth.session.fullName,
          createdAt: now,
          updatedAt: now,
        };
        await db.collection("recurringInvoices").insertOne(schedule, { session });
        await writeAudit(db, auth.session, "recurring_invoice.create", "recurringInvoice", id.toHexString(), {
          scheduleNo: schedule.scheduleNo, memberNo: member.memberNo, frequency: schedule.frequency,
          nextRunDate: schedule.nextRunDate, plannedTotal: schedule.plannedTotal, currency: schedule.plannedCurrency,
        }, session);
        return { schedule, isNew: true };
      });
      return result.isNew ? created(serialise(result.schedule)) : ok(serialise(result.schedule));
    } finally { await session.endSession(); }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existing = await (await getDb()).collection("recurringInvoices").findOne({ _id: id, clientRequestId: input.data.clientRequestId });
      if (existing) return ok(serialise(existing));
    }
    if (error instanceof RecurringInvoiceError) return fail(error.message, error.status);
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
  const input = recurringInvoiceActionSchema.safeParse(body.value);
  if (!input.success) return fail("Check the schedule action.", 422, input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const client = await getMongoClient();
    const command = input.data;
    if (command.action === "RUN_DUE") {
      return ok(await generateDueRecurringInvoices(db, client, auth.session, new Date(), 25));
    }
    const session = client.startSession();
    try {
      const schedule = await session.withTransaction(async () => {
        const id = new ObjectId(command.id);
        const current = await db.collection("recurringInvoices").findOne({ _id: id }, { session });
        if (!current) throw new RecurringInvoiceError("This schedule could not be found.", 404);
        assertRecurringInvoiceVersion(current.updatedAt, command.expectedUpdatedAt);
        assertRecurringInvoiceAction(current.status, command.action);
        const status = command.action === "PAUSE" ? "PAUSED" : command.action === "RESUME" ? "ACTIVE" : "ENDED";
        const updatedAt = nextInvoiceUpdatedAt(current.updatedAt);
        const updated = await db.collection("recurringInvoices").findOneAndUpdate(
          { _id: id, status: current.status, updatedAt: current.updatedAt },
          { $set: { status, updatedAt, ...(status === "ENDED" ? { endedAt: updatedAt } : {}) } },
          { returnDocument: "after", session },
        );
        if (!updated) throw new RecurringInvoiceError("This schedule changed. Refresh before trying again.");
        await writeAudit(db, auth.session, `recurring_invoice.${command.action.toLowerCase()}`, "recurringInvoice", command.id, {
          scheduleNo: current.scheduleNo, previousStatus: current.status, status,
        }, session);
        return updated;
      });
      return ok(serialise(schedule));
    } finally { await session.endSession(); }
  } catch (error) {
    if (error instanceof RecurringInvoiceError) return fail(error.message, error.status);
    return publicError(error);
  }
}
