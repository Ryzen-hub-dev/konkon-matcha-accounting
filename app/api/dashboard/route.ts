import { authorize, ok, publicError } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { businessPeriodKeys, shiftDateKey } from "@/lib/dates";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorize("dashboard.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const period = businessPeriodKeys(new Date(), settings.timeZone);
    const matchPeriod = (from: string) => ({
      status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] },
      createdAt: { $gte: new Date(`${shiftDateKey(from, -2)}T00:00:00Z`), $lt: new Date(`${shiftDateKey(period.today, 2)}T00:00:00Z`) },
      $expr: { $and: [
        { $gte: [{ $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: settings.timeZone } }, from] },
        { $lte: [{ $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: settings.timeZone } }, period.today] },
      ] },
    });
    const [todayAgg, monthAgg, memberCount, lowStockCount, recentSales, dailySales, topProducts] = await Promise.all([
      db.collection("sales").aggregate([
        { $match: matchPeriod(period.today) },
        { $group: { _id: null, revenue: { $sum: { $subtract: ["$total", { $ifNull: ["$refundedAmount", 0] }] } }, transactions: { $sum: 1 }, averageSale: { $avg: { $subtract: ["$total", { $ifNull: ["$refundedAmount", 0] }] } } } },
      ]).next(),
      db.collection("sales").aggregate([
        { $match: matchPeriod(period.month) },
        { $group: { _id: null, revenue: { $sum: { $subtract: ["$total", { $ifNull: ["$refundedAmount", 0] }] } }, transactions: { $sum: 1 } } },
      ]).next(),
      db.collection("members").countDocuments({ active: { $ne: false } }),
      db.collection("products").countDocuments({ active: { $ne: false }, $expr: { $lte: ["$stock", "$reorderLevel"] } }),
      db.collection("sales").find({ status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] } }).sort({ createdAt: -1 }).limit(6).project({ receiptNo: 1, memberName: 1, total: 1, refundedAmount: 1, paymentMethod: 1, paymentMethodName: 1, status: 1, createdAt: 1 }).toArray(),
      db.collection("sales").aggregate([
        { $match: matchPeriod(period.days[0]) },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: settings.timeZone } }, total: { $sum: { $subtract: ["$total", { $ifNull: ["$refundedAmount", 0] }] } } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      db.collection("sales").aggregate([
        { $match: matchPeriod(period.month) },
        { $unwind: "$items" },
        { $group: { _id: "$items.productId", name: { $first: "$items.name" }, quantity: { $sum: { $subtract: ["$items.quantity", { $ifNull: ["$items.refundedQuantity", 0] }] } }, revenue: { $sum: { $subtract: ["$items.lineTotal", { $ifNull: ["$items.refundedLineTotal", 0] }] } } } },
        { $match: { quantity: { $gt: 0 } } },
        { $sort: { revenue: -1 } }, { $limit: 5 },
      ]).toArray(),
    ]);
    return ok(serialise({
      today: { revenue: todayAgg?.revenue || 0, transactions: todayAgg?.transactions || 0, averageSale: todayAgg?.averageSale || 0 },
      month: { revenue: monthAgg?.revenue || 0, transactions: monthAgg?.transactions || 0 },
      memberCount,
      lowStockCount,
      recentSales,
      dailySales: period.days.map(day => ({ _id: day, total: dailySales.find(point => point._id === day)?.total || 0 })),
      period: { ...period, timeZone: settings.timeZone, currency: settings.currency },
      topProducts,
    }));
  } catch (error) {
    return publicError(error);
  }
}
