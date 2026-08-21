import { fail, authorize, ok, publicError } from "@/lib/api";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb } from "@/lib/db";
import {
  assembleFinancialStatements,
  buildAgingReport,
  type AccountMovement,
  type CashSourceMovement,
  type FinancialAccount,
} from "@/lib/financial-reports";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function validDateKey(value: string) {
  if (!DATE_ONLY.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function utcBoundary(value: string, dayOffset: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date;
}

export async function GET(request: Request) {
  const auth = await authorize("reports.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const url = new URL(request.url);
    const today = dateKeyInTimeZone(new Date(), settings.timeZone);
    const from = url.searchParams.get("from") || `${today.slice(0, 8)}01`;
    const to = url.searchParams.get("to") || today;
    if (!validDateKey(from) || !validDateKey(to) || from > to) return fail("Choose a valid reporting period.", 422);
    const periodDays = Math.floor((utcBoundary(to, 0).getTime() - utcBoundary(from, 0).getTime()) / 86_400_000) + 1;
    if (periodDays > 3_653) return fail("Choose a reporting period of 10 years or less.", 422);

    const journalUpper = utcBoundary(to, 2);
    const activityLower = utcBoundary(from, -2);
    const activityUpper = utcBoundary(to, 2);
    const reportDateExpression = (field: string) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: settings.timeZone } });
    const trendFormat = periodDays > 120 ? "%Y-%m" : "%Y-%m-%d";

    const accounts = await db.collection("chartOfAccounts").find({ active: { $ne: false } }).project({ code: 1, name: 1, type: 1, cashEquivalent: 1 }).sort({ code: 1 }).toArray();
    const cashAccountCodes = accounts.filter((account) => account.cashEquivalent === true || ["1000", "1010"].includes(String(account.code))).map((account) => String(account.code));

    const [
      movementDocuments,
      cashDocuments,
      journalQuality,
      salesSummary,
      trend,
      payments,
      inventoryValue,
      receivableDocuments,
      payableDocuments,
      draftInvoiceCount,
    ] = await Promise.all([
      db.collection("journalEntries").aggregate([
        { $match: { status: "POSTED", date: { $lt: journalUpper } } },
        { $addFields: { _reportDate: reportDateExpression("$date") } },
        { $unwind: "$lines" },
        { $group: {
          _id: "$lines.accountCode",
          name: { $last: "$lines.accountName" },
          openingDebit: { $sum: { $cond: [{ $lt: ["$_reportDate", from] }, { $ifNull: ["$lines.debit", 0] }, 0] } },
          openingCredit: { $sum: { $cond: [{ $lt: ["$_reportDate", from] }, { $ifNull: ["$lines.credit", 0] }, 0] } },
          periodDebit: { $sum: { $cond: [{ $and: [{ $gte: ["$_reportDate", from] }, { $lte: ["$_reportDate", to] }] }, { $ifNull: ["$lines.debit", 0] }, 0] } },
          periodCredit: { $sum: { $cond: [{ $and: [{ $gte: ["$_reportDate", from] }, { $lte: ["$_reportDate", to] }] }, { $ifNull: ["$lines.credit", 0] }, 0] } },
        } },
      ]).toArray(),
      cashAccountCodes.length ? db.collection("journalEntries").aggregate([
        { $match: { status: "POSTED", date: { $lt: journalUpper } } },
        { $addFields: { _reportDate: reportDateExpression("$date") } },
        { $unwind: "$lines" },
        { $match: { "lines.accountCode": { $in: cashAccountCodes } } },
        { $group: {
          _id: { $ifNull: ["$source", "MANUAL"] },
          openingAmount: { $sum: { $cond: [{ $lt: ["$_reportDate", from] }, { $subtract: [{ $ifNull: ["$lines.debit", 0] }, { $ifNull: ["$lines.credit", 0] }] }, 0] } },
          periodAmount: { $sum: { $cond: [{ $and: [{ $gte: ["$_reportDate", from] }, { $lte: ["$_reportDate", to] }] }, { $subtract: [{ $ifNull: ["$lines.debit", 0] }, { $ifNull: ["$lines.credit", 0] }] }, 0] } },
        } },
      ]).toArray() : Promise.resolve([]),
      db.collection("journalEntries").aggregate([
        { $match: { status: "POSTED", date: { $gte: activityLower, $lt: activityUpper } } },
        { $addFields: { _reportDate: reportDateExpression("$date") } },
        { $match: { _reportDate: { $gte: from, $lte: to } } },
        { $group: {
          _id: null,
          entryCount: { $sum: 1 },
          unbalancedEntries: { $sum: { $cond: [{ $gt: [{ $abs: { $subtract: [{ $ifNull: ["$totalDebit", 0] }, { $ifNull: ["$totalCredit", 0] }] } }, 0.004] }, 1, 0] } },
        } },
      ]).next(),
      db.collection("sales").aggregate([
        { $match: { status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { $gte: activityLower, $lt: activityUpper } } },
        { $addFields: { _reportDate: reportDateExpression("$createdAt") } },
        { $match: { _reportDate: { $gte: from, $lte: to } } },
        { $group: {
          _id: null,
          revenue: { $sum: { $subtract: [{ $ifNull: ["$netSales", "$total"] }, { $ifNull: ["$refundedNetSales", 0] }] } },
          cost: { $sum: { $subtract: [{ $ifNull: ["$totalCost", 0] }, { $ifNull: ["$refundedCost", 0] }] } },
          transactions: { $sum: 1 },
          items: { $sum: { $subtract: [{ $sum: "$items.quantity" }, { $ifNull: ["$refundedQuantityTotal", 0] }] } },
        } },
      ]).next(),
      db.collection("sales").aggregate([
        { $match: { status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { $gte: activityLower, $lt: activityUpper } } },
        { $addFields: { _reportDate: reportDateExpression("$createdAt") } },
        { $match: { _reportDate: { $gte: from, $lte: to } } },
        { $group: {
          _id: { $dateToString: { format: trendFormat, date: "$createdAt", timezone: settings.timeZone } },
          revenue: { $sum: { $subtract: [{ $ifNull: ["$netSales", "$total"] }, { $ifNull: ["$refundedNetSales", 0] }] } },
          cost: { $sum: { $subtract: [{ $ifNull: ["$totalCost", 0] }, { $ifNull: ["$refundedCost", 0] }] } },
        } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      db.collection("sales").aggregate([
        { $match: { status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { $gte: activityLower, $lt: activityUpper } } },
        { $addFields: { _reportDate: reportDateExpression("$createdAt") } },
        { $match: { _reportDate: { $gte: from, $lte: to } } },
        { $group: { _id: { $ifNull: ["$paymentMethodName", "$paymentMethod"] }, value: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$refundedAmount", 0] }] } }, count: { $sum: 1 } } },
        { $sort: { value: -1 } },
      ]).toArray(),
      db.collection("products").aggregate([
        { $match: { active: { $ne: false } } },
        { $group: { _id: null, retail: { $sum: { $multiply: [{ $ifNull: ["$stock", 0] }, { $ifNull: ["$price", 0] }] } }, cost: { $sum: { $multiply: [{ $ifNull: ["$stock", 0] }, { $ifNull: ["$cost", 0] }] } }, units: { $sum: { $ifNull: ["$stock", 0] } } } },
      ]).next(),
      db.collection("invoices").find({ status: "SENT", $expr: { $gt: [{ $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$paidAmount", 0] }] }, 0] } }).project({ invoiceNo: 1, customerName: 1, dueDate: 1, total: 1, paidAmount: 1, status: 1 }).toArray(),
      db.collection("accountsPayableBills").find({ status: { $in: ["OPEN", "PARTIALLY_PAID", "OVERDUE"] }, baseBalance: { $gt: 0 } }).project({ billNo: 1, supplierName: 1, dueDate: 1, baseBalance: 1, status: 1 }).toArray(),
      db.collection("invoices").countDocuments({ status: "DRAFT" }),
    ]);

    const financialAccounts: FinancialAccount[] = accounts.map((account) => ({
      code: String(account.code),
      name: String(account.name),
      type: String(account.type) as FinancialAccount["type"],
      cashEquivalent: account.cashEquivalent === true,
    }));
    const movements: AccountMovement[] = movementDocuments.map((movement) => ({
      code: String(movement._id),
      name: String(movement.name || ""),
      openingDebit: Number(movement.openingDebit || 0),
      openingCredit: Number(movement.openingCredit || 0),
      periodDebit: Number(movement.periodDebit || 0),
      periodCredit: Number(movement.periodCredit || 0),
    }));
    const cashMovements: CashSourceMovement[] = cashDocuments.map((movement) => ({
      source: String(movement._id || "MANUAL"),
      openingAmount: Number(movement.openingAmount || 0),
      periodAmount: Number(movement.periodAmount || 0),
    }));
    const statements = assembleFinancialStatements({ accounts: financialAccounts, movements, cashMovements, currency: settings.currency });
    const agedReceivables = buildAgingReport(receivableDocuments.map((invoice) => ({
      id: String(invoice._id), documentNo: String(invoice.invoiceNo), party: String(invoice.customerName), dueDate: invoice.dueDate as Date,
      balance: Number(invoice.total || 0) - Number(invoice.paidAmount || 0), status: String(invoice.status),
    })), to, settings.currency);
    const agedPayables = buildAgingReport(payableDocuments.map((bill) => ({
      id: String(bill._id), documentNo: String(bill.billNo), party: String(bill.supplierName), dueDate: bill.dueDate as Date,
      balance: Number(bill.baseBalance || 0), status: String(bill.status),
    })), to, settings.currency);
    const unbalancedEntries = Number(journalQuality?.unbalancedEntries || 0);
    const integrity = {
      ...statements.integrity,
      journalCount: Number(journalQuality?.entryCount || 0),
      unbalancedEntries,
      balanced: statements.integrity.balanced && unbalancedEntries === 0,
    };
    const revenue = Number(salesSummary?.revenue || 0);
    const cost = Number(salesSummary?.cost || 0);

    return ok(serialise({
      period: { from, to, days: periodDays, timeZone: settings.timeZone, currency: settings.currency, trendInterval: periodDays > 120 ? "MONTH" : "DAY" },
      ...statements,
      integrity,
      operations: {
        summary: { revenue, cost, grossProfit: revenue - cost, margin: revenue ? ((revenue - cost) / revenue) * 100 : 0, transactions: Number(salesSummary?.transactions || 0), items: Number(salesSummary?.items || 0) },
        trend,
        payments,
        inventoryValue: inventoryValue || { retail: 0, cost: 0, units: 0 },
        draftInvoiceCount,
      },
      aging: { receivables: agedReceivables, payables: agedPayables },
    }));
  } catch (error) {
    return publicError(error);
  }
}
