import { z } from "zod";
import { roundCurrency } from "@/lib/international";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid customer account.").transform(value => value.toLowerCase());

export const customerAccountUpdateSchema = z.object({
  id: objectIdSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  creditLimit: z.number().finite().min(0).max(100_000_000).nullable(),
  creditTermsDays: z.coerce.number().int().min(0).max(365),
  creditHold: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});

export type CreditDecision = {
  allowed: boolean;
  projectedOutstanding: number;
  reason?: string;
};

export function evaluateCustomerCredit(input: {
  creditHold?: boolean;
  creditLimit?: number | null;
  outstanding: number;
  newCharge: number;
  currency: string;
}): CreditDecision {
  const projectedOutstanding = roundCurrency(input.outstanding + input.newCharge, input.currency);
  if (input.creditHold) {
    return { allowed: false, projectedOutstanding, reason: "This customer account is on credit hold. Remove the hold before sending an invoice." };
  }
  if (input.creditLimit !== null && input.creditLimit !== undefined && projectedOutstanding > input.creditLimit) {
    return { allowed: false, projectedOutstanding, reason: "Sending this invoice would exceed the customer's credit limit." };
  }
  return { allowed: true, projectedOutstanding };
}

export type StatementInvoice = {
  _id: unknown;
  invoiceNo: string;
  status: string;
  total: number;
  paidAmount?: number;
  createdAt: Date | string;
  sentAt?: Date | string;
  paidAt?: Date | string;
  updatedAt?: Date | string;
  dueDate: Date | string;
  customerReference?: string;
};

export type StatementEntry = {
  id: string;
  date: string;
  type: "INVOICE" | "PAYMENT";
  invoiceNo: string;
  reference: string;
  dueDate: string;
  charge: number;
  payment: number;
  balance: number;
};

function iso(value: Date | string | undefined) {
  const date = value instanceof Date ? value : new Date(String(value || 0));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

export function buildCustomerStatement(invoices: StatementInvoice[], currency: string, today: string) {
  const issued = invoices.filter(invoice => invoice.status === "SENT" || invoice.status === "PAID");
  const events = issued.flatMap(invoice => {
    const id = String(invoice._id);
    const charge = roundCurrency(Number(invoice.total || 0), currency);
    const paid = roundCurrency(Number(invoice.paidAmount || 0), currency);
    const entries: Array<Omit<StatementEntry, "balance"> & { order: number }> = [{
      id: `${id}:invoice`, date: iso(invoice.sentAt || invoice.createdAt), type: "INVOICE", invoiceNo: invoice.invoiceNo,
      reference: invoice.customerReference || "", dueDate: iso(invoice.dueDate), charge, payment: 0, order: 0,
    }];
    if (paid > 0) entries.push({
      id: `${id}:payment`, date: iso(invoice.paidAt || invoice.updatedAt || invoice.createdAt), type: "PAYMENT", invoiceNo: invoice.invoiceNo,
      reference: "Payment received", dueDate: iso(invoice.dueDate), charge: 0, payment: paid, order: 1,
    });
    return entries;
  }).sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order || left.invoiceNo.localeCompare(right.invoiceNo));

  let running = 0;
  const entries: StatementEntry[] = events.map(({ order: _order, ...entry }) => {
    running = roundCurrency(running + entry.charge - entry.payment, currency);
    return { ...entry, balance: running };
  });
  const invoiced = roundCurrency(issued.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0), currency);
  const paid = roundCurrency(issued.reduce((sum, invoice) => sum + Number(invoice.paidAmount || 0), 0), currency);
  const overdue = roundCurrency(issued.reduce((sum, invoice) => {
    const open = invoice.status === "SENT" ? Number(invoice.total || 0) - Number(invoice.paidAmount || 0) : 0;
    return iso(invoice.dueDate).slice(0, 10) < today ? sum + open : sum;
  }, 0), currency);
  return { entries, summary: { invoiced, paid, outstanding: roundCurrency(invoiced - paid, currency), overdue } };
}
