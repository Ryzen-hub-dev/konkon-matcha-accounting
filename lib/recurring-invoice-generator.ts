import { ObjectId, type Db, type MongoClient } from "mongodb";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";
import { dateKeyInTimeZone } from "@/lib/dates";
import { DimensionSelectionError, resolveDocumentDimensionSelection } from "@/lib/dimension-selection";
import { makeDocumentNo } from "@/lib/format";
import { DEFAULT_INVOICE_TEMPLATE, normaliseInvoiceTemplate } from "@/lib/invoice-templates";
import { calculateInvoiceAmounts, invoiceBusinessSnapshot, InvoiceWorkflowError } from "@/lib/invoices";
import {
  advanceRecurringDate, recurringDueDate, recurringOccurrenceRequestId,
  RecurringInvoiceError, type RecurringFrequency,
} from "@/lib/recurring-invoices";

type SchedulerActor = { id: string; username: string; fullName: string; role: string };
type RunResult = { scanned: number; generated: number; alreadyGenerated: number; completed: number; failed: number };

function errorMessage(error: unknown) {
  if (error instanceof RecurringInvoiceError || error instanceof InvoiceWorkflowError || error instanceof DimensionSelectionError) return error.message.slice(0, 240);
  return "The draft could not be generated. Review this schedule and try again.";
}

export async function generateDueRecurringInvoices(
  db: Db,
  client: MongoClient,
  actor: SchedulerActor,
  now = new Date(),
  maxSchedules = 25,
): Promise<RunResult> {
  const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
  const today = dateKeyInTimeZone(now, business.timeZone);
  const schedules = await db.collection("recurringInvoices").find({ status: "ACTIVE", nextRunDate: { $lte: today } })
    .sort({ nextRunDate: 1, createdAt: 1 }).limit(Math.max(1, Math.min(maxSchedules, 50))).toArray();
  const result: RunResult = { scanned: schedules.length, generated: 0, alreadyGenerated: 0, completed: 0, failed: 0 };

  for (const queued of schedules) {
    const session = client.startSession();
    try {
      const outcome = await session.withTransaction(async () => {
        const scheduleId = queued._id instanceof ObjectId ? queued._id : new ObjectId(String(queued._id));
        const occurrenceDate = String(queued.nextRunDate || "");
        await touchBusinessKeyLock(db, businessKeyLockId("recurring-invoice", scheduleId.toHexString(), occurrenceDate), session, now);
        const schedule = await db.collection("recurringInvoices").findOne({ _id: scheduleId, status: "ACTIVE", nextRunDate: occurrenceDate }, { session });
        if (!schedule) return "SKIPPED" as const;
        const member = await db.collection("members").findOne({ _id: schedule.memberId, active: { $ne: false } }, { session });
        if (!member) throw new RecurringInvoiceError("The linked customer account is no longer active. Choose a replacement schedule.", 422);
        const selectedTemplate = schedule.templateId
          ? await db.collection("invoiceTemplates").findOne({ _id: schedule.templateId, active: { $ne: false } }, { session })
          : await db.collection("invoiceTemplates").findOne({ isDefault: true, active: { $ne: false } }, { session });
        if (schedule.templateId && !selectedTemplate) throw new RecurringInvoiceError("The selected invoice template is no longer available.", 422);
        const templateSnapshot = normaliseInvoiceTemplate(selectedTemplate || DEFAULT_INVOICE_TEMPLATE);
        const dimensionSelection = await resolveDocumentDimensionSelection(db, schedule.dimensionSelectionInput, member, session, now);
        const amounts = calculateInvoiceAmounts(schedule.items || [], business.currency, business.taxRate, business.taxMode);
        const clientRequestId = recurringOccurrenceRequestId(scheduleId.toHexString(), occurrenceDate);
        let invoice = await db.collection("invoices").findOne({ clientRequestId }, { session });
        let generated = false;
        if (!invoice) {
          invoice = {
            _id: new ObjectId(),
            invoiceNo: makeDocumentNo("INV"),
            clientRequestId,
            sourceRecurringScheduleId: scheduleId,
            sourceRecurringScheduleNo: schedule.scheduleNo,
            recurringOccurrenceDate: occurrenceDate,
            memberId: member._id,
            memberNo: member.memberNo,
            customerName: String(member.name || schedule.customerName || "Customer"),
            customerEmail: String(member.email || ""),
            customerPhone: String(member.phone || ""),
            customerAddress: String(schedule.billingAddress || ""),
            customerReference: String(schedule.customerReference || ""),
            dueDate: new Date(`${recurringDueDate(occurrenceDate, Number(schedule.dueDays || 0))}T00:00:00.000Z`),
            notes: String(schedule.notes || ""),
            templateId: selectedTemplate?._id || null,
            templateName: templateSnapshot.name,
            templateSnapshot,
            dimensionSelection,
            businessSnapshot: invoiceBusinessSnapshot(business),
            ...amounts,
            paidAmount: 0,
            status: "DRAFT",
            creationSource: "RECURRING_SCHEDULE",
            createdBy: ObjectId.isValid(actor.id) ? new ObjectId(actor.id) : actor.id,
            createdByName: actor.fullName,
            createdAt: now,
            updatedAt: now,
          };
          await db.collection("invoices").insertOne(invoice, { session });
          generated = true;
          await writeAudit(db, actor, "invoice.create", "invoice", invoice._id.toHexString(), {
            invoiceNo: invoice.invoiceNo, total: invoice.total, memberNo: member.memberNo,
            source: "RECURRING_SCHEDULE", scheduleNo: schedule.scheduleNo,
          }, session);
        }
        const nextRunDate = advanceRecurringDate(occurrenceDate, schedule.frequency as RecurringFrequency, Number(schedule.anchorDay));
        const completed = Boolean(schedule.endDate && nextRunDate > String(schedule.endDate));
        await db.collection("recurringInvoices").updateOne(
          { _id: scheduleId, status: "ACTIVE", nextRunDate: occurrenceDate },
          { $set: {
            status: completed ? "COMPLETED" : "ACTIVE",
            nextRunDate, lastRunDate: occurrenceDate, lastGeneratedAt: now,
            lastInvoiceId: invoice._id, lastInvoiceNo: invoice.invoiceNo,
            lastError: "", updatedAt: now,
          } },
          { session },
        );
        await writeAudit(db, actor, "recurring_invoice.generate", "recurringInvoice", scheduleId.toHexString(), {
          scheduleNo: schedule.scheduleNo, occurrenceDate, invoiceNo: invoice.invoiceNo,
          generated, completed, nextRunDate,
        }, session);
        return generated ? (completed ? "GENERATED_COMPLETED" : "GENERATED") : (completed ? "EXISTING_COMPLETED" : "EXISTING");
      });
      if (outcome === "GENERATED" || outcome === "GENERATED_COMPLETED") result.generated += 1;
      if (outcome === "EXISTING" || outcome === "EXISTING_COMPLETED") result.alreadyGenerated += 1;
      if (outcome === "GENERATED_COMPLETED" || outcome === "EXISTING_COMPLETED") result.completed += 1;
    } catch (error) {
      result.failed += 1;
      const message = errorMessage(error);
      await db.collection("recurringInvoices").updateOne(
        { _id: queued._id, status: "ACTIVE" },
        { $set: { lastError: message, lastAttemptAt: now, updatedAt: now } },
      ).catch(() => undefined);
    } finally {
      await session.endSession();
    }
  }
  return result;
}
