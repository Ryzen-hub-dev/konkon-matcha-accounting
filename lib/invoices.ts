import { z } from "zod";
import { isValidDateKey } from "@/lib/dates";
import { currencyFractionDigits, roundCurrency } from "@/lib/international";
import { calculateTaxTotals, type TaxMode } from "@/lib/tax";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid invoice reference.").transform(value => value.toLowerCase());

// Preserve calendar dates; only the old UTC-midnight transport format is accepted.
export const invoiceDueDateSchema = z.string().trim().refine(value =>
  /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value) && isValidDateKey(value.slice(0, 10)),
"Choose a valid due date.").transform(value => new Date(`${value.slice(0, 10)}T00:00:00.000Z`));

export const invoiceVersionSchema = z.string().datetime({ offset: true }).refine(value => isValidDateKey(value.slice(0, 10)), "Refresh the invoice before saving.");

const invoiceFieldsSchema = z.object({
  memberId: z.union([objectIdSchema, z.literal("")]).optional(),
  customerName: z.string().trim().min(2).max(120),
  customerEmail: z.union([z.string().trim().email(), z.literal("")]),
  customerPhone: z.string().trim().max(40),
  customerAddress: z.string().trim().max(300),
  customerReference: z.string().trim().max(80),
  dueDate: invoiceDueDateSchema,
  notes: z.string().trim().max(500),
  templateId: z.union([objectIdSchema, z.literal("")]),
  items: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    quantity: z.coerce.number().positive().max(100_000),
    unitPrice: z.coerce.number().min(0).max(100_000_000),
  })).min(1).max(50),
});

export const invoiceInputSchema = invoiceFieldsSchema.extend({
  memberId: invoiceFieldsSchema.shape.memberId.default(""),
  customerEmail: invoiceFieldsSchema.shape.customerEmail.default(""),
  customerPhone: invoiceFieldsSchema.shape.customerPhone.default(""),
  customerAddress: invoiceFieldsSchema.shape.customerAddress.default(""),
  customerReference: invoiceFieldsSchema.shape.customerReference.default(""),
  notes: invoiceFieldsSchema.shape.notes.default(""),
  templateId: invoiceFieldsSchema.shape.templateId.default(""),
  clientRequestId: z.string().uuid().optional(),
});

export const invoiceEditSchema = invoiceFieldsSchema.extend({
  action: z.literal("EDIT_DRAFT"),
  id: objectIdSchema,
  expectedUpdatedAt: invoiceVersionSchema,
});

export const invoiceStatusSchema = z.object({
  id: objectIdSchema,
  status: z.enum(["DRAFT", "SENT", "PAID", "VOID"]),
  expectedUpdatedAt: invoiceVersionSchema.optional(),
});

export class InvoiceWorkflowError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function calculateInvoiceAmounts(
  values: Array<{ description: string; quantity: number; unitPrice: number }>,
  currency: string, taxRate: number, taxMode: TaxMode,
) {
  const items = values.map(item => {
    const unitPrice = roundCurrency(item.unitPrice, currency);
    return { ...item, unitPrice, lineTotal: roundCurrency(item.quantity * unitPrice, currency) };
  });
  const subtotal = roundCurrency(items.reduce((sum, item) => sum + item.lineTotal, 0), currency);
  const totals = calculateTaxTotals(subtotal, 0, taxRate, taxMode, currency);
  const factor = 10 ** currencyFractionDigits(currency);
  if (![subtotal, totals.total, totals.tax, totals.netSales, ...items.map(item => item.lineTotal)]
    .every(amount => Number.isFinite(amount) && Number.isSafeInteger(Math.round(amount * factor)))) {
    throw new InvoiceWorkflowError("The invoice amount is too large to represent safely. Reduce its quantity or amount.", 422);
  }
  return { items, subtotal, taxRate: totals.taxRate, taxMode: totals.taxMode, tax: totals.tax, netSales: totals.netSales, total: totals.total };
}

export function assertInvoiceDraftEditable(invoice: { status: unknown; paidAmount?: unknown }) {
  if (invoice.status !== "DRAFT" || Number(invoice.paidAmount || 0) !== 0) {
    throw new InvoiceWorkflowError("Only an unpaid draft can be edited. Refresh the invoice to see its current status.");
  }
}

export function assertInvoiceStatusTransition(invoice: { status: unknown; paidAmount?: unknown }, target: string) {
  if (invoice.status === "VOID") throw new InvoiceWorkflowError("This invoice is already void and cannot be changed.");
  if (invoice.status === "PAID") {
    if (target === "PAID") return;
    throw new InvoiceWorkflowError("A paid invoice cannot be reopened. Create a reversing journal if needed.");
  }
  if (!["DRAFT", "SENT"].includes(String(invoice.status)) || Number(invoice.paidAmount || 0) !== 0) {
    throw new InvoiceWorkflowError("This invoice cannot be changed through the draft workflow.");
  }
  if (invoice.status === "SENT" && target === "DRAFT") {
    throw new InvoiceWorkflowError("A sent invoice cannot be reopened as a draft. Void it and create a replacement if needed.");
  }
}

export function assertInvoiceVersion(updatedAt: unknown, expectedUpdatedAt?: string) {
  if (!expectedUpdatedAt) return;
  const actual = updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime();
  if (!Number.isFinite(actual) || actual !== new Date(expectedUpdatedAt).getTime()) {
    throw new InvoiceWorkflowError("This invoice changed in another session. Refresh it before trying again.");
  }
}

export function nextInvoiceUpdatedAt(previous: unknown, now = new Date()) {
  const previousTime = previous instanceof Date ? previous.getTime() : new Date(String(previous)).getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(previousTime) ? previousTime + 1 : 0));
}
