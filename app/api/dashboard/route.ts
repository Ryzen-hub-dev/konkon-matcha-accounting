import { authorize, ok, publicError } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

function singaporeStartOfDay() {
  const now = new Date();
  const sg = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(sg.getUTCFullYear(), sg.getUTCMonth(), sg.getUTCDate()) - 8 * 60 * 60 * 1000);
}

export async function GET() {
  const auth = await authorize("dashboard.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const today = singaporeStartOfDay();
    const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) - 8 * 60 * 60 * 1000);
    const [todayAgg, monthAgg, memberCount, lowStockCount, recentSales, dailySales, topProducts] = await Promise.all([
      db.collection("sales").aggregate([
        { $match: { status: "COMPLETED", createdAt: { $gte: today } } },
        { $group: { _id: null, revenue: { $sum: "$total" }, transactions: { $sum: 1 }, averageSale: { $avg: "$total" } } },
      ]).next(),
      db.collection("sales").aggregate([
        { $match: { status: "COMPLETED", createdAt: { $gte: month } } },
        { $group: { _id: null, revenue: { $sum: "$total" }, transactions: { $sum: 1 } } },
      ]).next(),
      db.collection("members").countDocuments({ active: { $ne: false } }),
      db.collection("products").countDocuments({ active: { $ne: false }, $expr: { $lte: ["$stock", "$reorderLevel"] } }),
      db.collection("sales").find({ status: "COMPLETED" }).sort({ createdAt: -1 }).limit(6).project({ receiptNo: 1, memberName: 1, total: 1, paymentMethod: 1, createdAt: 1 }).toArray(),
      db.collection("sales").aggregate([
        { $match: { status: "COMPLETED", createdAt: { $gte: new Date(Date.now() - 6 * 86400000) } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+08:00" } }, total: { $sum: "$total" } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      db.collection("sales").aggregate([
        { $match: { status: "COMPLETED", createdAt: { $gte: month } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.productId", name: { $first: "$items.name" }, quantity: { $sum: "$items.quantity" }, revenue: { $sum: "$items.lineTotal" } } },
        { $sort: { revenue: -1 } }, { $limit: 5 },
      ]).toArray(),
    ]);
    return ok(serialise({
      today: { revenue: todayAgg?.revenue || 0, transactions: todayAgg?.transactions || 0, averageSale: todayAgg?.averageSale || 0 },
      month: { revenue: monthAgg?.revenue || 0, transactions: monthAgg?.transactions || 0 },
      memberCount,
      lowStockCount,
      recentSales,
      dailySales,
      topProducts,
    }));
  } catch (error) {
    return publicError(error);
  }
}
