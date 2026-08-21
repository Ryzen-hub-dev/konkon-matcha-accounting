import { authorize, ok, publicError } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await authorize("reports.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const requestedDays = Number(url.searchParams.get("days") || 30);
    const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
    const from = new Date(Date.now() - days * 86400000);
    const [summary, trend, payments, inventoryValue, receivables] = await Promise.all([
      db.collection("sales").aggregate([
        { $match: { status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { $gte: from } } },
        { $group: { _id: null, revenue: { $sum: { $subtract: [{ $ifNull: ["$netSales", "$total"] }, { $ifNull: ["$refundedNetSales", 0] }] } }, cost: { $sum: { $subtract: ["$totalCost", { $ifNull: ["$refundedCost", 0] }] } }, transactions: { $sum: 1 }, items: { $sum: { $subtract: [{ $sum: "$items.quantity" }, { $ifNull: ["$refundedQuantityTotal", 0] }] } } } },
      ]).next(),
      db.collection("sales").aggregate([
        { $match: { status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { $gte: from } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+08:00" } }, revenue: { $sum: { $subtract: [{ $ifNull: ["$netSales", "$total"] }, { $ifNull: ["$refundedNetSales", 0] }] } }, cost: { $sum: { $subtract: ["$totalCost", { $ifNull: ["$refundedCost", 0] }] } } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      db.collection("sales").aggregate([
        { $match: { status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { $gte: from } } },
        { $group: { _id: "$paymentMethod", value: { $sum: { $subtract: ["$total", { $ifNull: ["$refundedAmount", 0] }] } }, count: { $sum: 1 } } },
        { $sort: { value: -1 } },
      ]).toArray(),
      db.collection("products").aggregate([
        { $match: { active: { $ne: false } } },
        { $group: { _id: null, retail: { $sum: { $multiply: ["$stock", "$price"] } }, cost: { $sum: { $multiply: ["$stock", "$cost"] } }, units: { $sum: "$stock" } } },
      ]).next(),
      db.collection("invoices").aggregate([
        { $match: { status: { $in: ["SENT", "DRAFT"] } } },
        { $group: { _id: null, outstanding: { $sum: { $subtract: ["$total", "$paidAmount"] } }, count: { $sum: 1 } } },
      ]).next(),
    ]);
    const revenue = Number(summary?.revenue || 0);
    const cost = Number(summary?.cost || 0);
    return ok(serialise({ days, summary: { revenue, cost, grossProfit: revenue - cost, margin: revenue ? ((revenue - cost) / revenue) * 100 : 0, transactions: summary?.transactions || 0, items: summary?.items || 0 }, trend, payments, inventoryValue: inventoryValue || { retail: 0, cost: 0, units: 0 }, receivables: receivables || { outstanding: 0, count: 0 } }));
  } catch (error) {
    return publicError(error);
  }
}
