import "server-only";
import type { ClientSession, Db } from "mongodb";
import { AccountingPeriodClosedError, periodKeyFromDateKey } from "@/lib/accounting-periods";

export async function assertAccountingPeriodOpen(db: Db, businessDateKey: string, session: ClientSession) {
  const periodKey = periodKeyFromDateKey(businessDateKey);
  const now = new Date();
  try {
    const result = await db.collection("accountingPeriods").updateOne(
      { periodKey, status: { $ne: "CLOSED" } },
      {
        $setOnInsert: {
          periodKey, periodStart: new Date(`${periodKey}-01T00:00:00.000Z`),
          status: "OPEN", createdAt: now, updatedAt: now,
        },
        $inc: { postingVersion: 1 },
      },
      { upsert: true, session },
    );
    if (!result.acknowledged) throw new AccountingPeriodClosedError(periodKey);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new AccountingPeriodClosedError(periodKey);
    throw error;
  }
  return periodKey;
}
