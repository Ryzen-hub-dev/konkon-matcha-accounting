import { ObjectId } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { dateKeyInTimeZone } from "@/lib/dates";
import { readExchangeRate } from "@/lib/exchange-rates";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";
import { allocateSupplierPayment, ensureProcurementAccounts, supplierPaymentSchema } from "@/lib/procurement";

export const runtime = "nodejs";

class PayableConflictError extends Error {}

export async function GET() {
  const auth = await authorize("payables.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [bills, payments, accounts] = await Promise.all([
      db.collection("accountsPayableBills").find({}).sort({ dueDate: 1, createdAt: -1 }).limit(500).toArray(),
      db.collection("supplierPayments").find({}).sort({ paidAt: -1 }).limit(300).toArray(),
      db.collection("chartOfAccounts").find({ type: "ASSET", active: { $ne: false }, $or: [{ cashEquivalent: true }, { code: { $in: ["1000", "1010"] } }] }).project({ code: 1, name: 1, type: 1 }).sort({ code: 1 }).toArray(),
    ]);
    const now = new Date();
    return ok(serialise({
      bills: bills.map((bill) => ({ ...bill, displayStatus: bill.status !== "PAID" && new Date(bill.dueDate).toISOString().slice(0, 10) < dateKeyInTimeZone(now, String(bill.timeZone || "UTC")) ? "OVERDUE" : bill.status })),
      payments,
      accounts,
    }));
  } catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("payables.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let body: unknown;
  try { body = await request.json(); } catch { return fail("The request body must be valid JSON.", 400); }
  const input = supplierPaymentSchema.safeParse(body);
  if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the supplier payment.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const existing = await db.collection("supplierPayments").findOne({ clientRequestId: input.data.clientRequestId });
    if (existing) {
      const bill = await db.collection("accountsPayableBills").findOne({ _id: existing.billId });
      return ok(serialise({ bill, payment: existing }));
    }
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    const paymentId = new ObjectId();
    const paymentNo = makeDocumentNo("APP");
    const journalNo = makeDocumentNo("JE");
    let result: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const bill = await db.collection("accountsPayableBills").findOne({ _id: new ObjectId(input.data.id), status: { $in: ["OPEN", "PARTIALLY_PAID"] } }, { session: mongoSession });
        if (!bill) throw new PayableConflictError("This supplier bill is already paid or no longer open.");
        const billTimeZone = String(bill.timeZone || "UTC");
        const paidDay = input.data.paidAt.toISOString().slice(0, 10);
        const invoiceDay = new Date(bill.invoiceDate).toISOString().slice(0, 10);
        const today = dateKeyInTimeZone(new Date(), billTimeZone);
        if (paidDay < invoiceDay || paidDay > today) throw new PayableConflictError("Payment date cannot precede the supplier invoice or be in the future.");
        const amount = roundCurrency(input.data.amount, String(bill.currency));
        if (currencyMinorUnits(amount, String(bill.currency)) <= 0 || currencyMinorUnits(amount, String(bill.currency)) > currencyMinorUnits(Number(bill.balance), String(bill.currency))) throw new PayableConflictError("Payment must be positive and cannot exceed the supplier bill balance.");
        const account = await db.collection("chartOfAccounts").findOne({ code: input.data.paymentAccountCode, type: "ASSET", active: { $ne: false }, $or: [{ cashEquivalent: true }, { code: { $in: ["1000", "1010"] } }] }, { session: mongoSession });
        if (!account) throw new PayableConflictError("Choose an active cash or bank account for this payment.");
        const exchange = await readExchangeRate(db, String(bill.baseCurrency), String(bill.currency));
        if (!exchange) throw new PayableConflictError(`Configure an active ${bill.baseCurrency}/${bill.currency} exchange rate before paying this bill.`);
        const currentPaid = Number(bill.paidAmount || 0);
        const currentBaseSettled = Number(bill.baseSettledAmount || 0);
        const allocation = allocateSupplierPayment({ total: Number(bill.total), baseTotal: Number(bill.baseTotal), balance: Number(bill.balance), baseBalance: Number(bill.baseBalance), amount, exchangeRate: exchange.rate, currency: String(bill.currency), baseCurrency: String(bill.baseCurrency) });
        const { finalPayment, carryingBaseAmount, baseCashAmount, exchangeGain, exchangeLoss } = allocation;
        if (carryingBaseAmount <= 0 || baseCashAmount <= 0) throw new PayableConflictError("The payment is below the supported accounting precision.");
        const paidAmount = roundCurrency(currentPaid + amount, String(bill.currency));
        const balance = finalPayment ? 0 : roundCurrency(Number(bill.total) - paidAmount, String(bill.currency));
        const baseSettledAmount = roundCurrency(currentBaseSettled + carryingBaseAmount, String(bill.baseCurrency));
        const baseBalance = finalPayment ? 0 : roundCurrency(Number(bill.baseTotal) - baseSettledAmount, String(bill.baseCurrency));
        const status = finalPayment ? "PAID" : "PARTIALLY_PAID";
        const postedAt = new Date();
        const updatedBill = await db.collection("accountsPayableBills").findOneAndUpdate(
          { _id: bill._id, status: bill.status, paidAmount: currentPaid },
          { $set: { paidAmount, balance, baseSettledAmount, baseBalance, status, ...(finalPayment ? { paidAt: input.data.paidAt } : {}), updatedAt: postedAt } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!updatedBill) throw new PayableConflictError("The bill changed while payment was posting. Reload before trying again.");
        const payment = {
          _id: paymentId, clientRequestId: input.data.clientRequestId, paymentNo, billId: bill._id, billNo: bill.billNo,
          supplierId: bill.supplierId, supplierCode: bill.supplierCode, supplierName: bill.supplierName,
          supplierInvoiceNo: bill.supplierInvoiceNo, purchaseOrderId: bill.purchaseOrderId, purchaseOrderNo: bill.purchaseOrderNo,
          amount, currency: bill.currency, carryingBaseAmount, baseCashAmount, baseCurrency: bill.baseCurrency,
          exchangeRate: exchange.rate, exchangeRateSource: exchange.source, exchangeGain, exchangeLoss,
          paymentAccountCode: account.code, paymentAccountName: account.name, reference: input.data.reference,
          referenceNormalized: input.data.reference.trim().toUpperCase(),
          notes: input.data.notes, paidAt: input.data.paidAt, createdBy: new ObjectId(auth.session.id), createdByName: auth.session.fullName, createdAt: postedAt,
        };
        await ensureProcurementAccounts(db, new ObjectId(auth.session.id), mongoSession);
        await db.collection("supplierPayments").insertOne(payment, { session: mongoSession });
        const journalLines = [
          { accountCode: "2000", accountName: "Accounts payable", debit: carryingBaseAmount, credit: 0 },
          ...(exchangeLoss > 0 ? [{ accountCode: "6200", accountName: "Foreign exchange loss", debit: exchangeLoss, credit: 0 }] : []),
          { accountCode: String(account.code), accountName: String(account.name), debit: 0, credit: baseCashAmount },
          ...(exchangeGain > 0 ? [{ accountCode: "4100", accountName: "Foreign exchange gain", debit: 0, credit: exchangeGain }] : []),
        ];
        const total = roundCurrency(carryingBaseAmount + exchangeLoss, String(bill.baseCurrency));
        await db.collection("journalEntries").insertOne({
          entryNo: journalNo, date: input.data.paidAt, memo: `Supplier payment ${paymentNo} · ${bill.supplierName}`,
          reference: input.data.reference, source: "SUPPLIER_PAYMENT", sourceId: paymentId, status: "POSTED", lines: journalLines,
          totalDebit: total, totalCredit: total, createdBy: new ObjectId(auth.session.id), createdAt: postedAt,
        }, { session: mongoSession });
        await writeAudit(db, auth.session, "accounts_payable.pay", "accountsPayableBill", input.data.id, { billNo: bill.billNo, paymentNo, amount, currency: bill.currency, baseCashAmount, exchangeGain, exchangeLoss, status }, mongoSession);
        result = { bill: updatedBill, payment };
      });
    } finally { await mongoSession.endSession(); }
    return ok(serialise(result));
  } catch (error) {
    if (error instanceof PayableConflictError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("This supplier payment request or bank reference was already posted. Refresh the bill before trying again.", 409);
    return publicError(error);
  }
}
