import "server-only";
import type { ClientSession, Db } from "mongodb";

export const FIXED_ASSET_ACCOUNTS = [
  { code: "1500", name: "Fixed assets at cost", type: "ASSET" },
  { code: "1510", name: "Accumulated depreciation", type: "ASSET" },
  { code: "4300", name: "Gain on asset disposal", type: "REVENUE" },
  { code: "6300", name: "Depreciation expense", type: "EXPENSE" },
  { code: "6400", name: "Loss on asset disposal", type: "EXPENSE" },
] as const;

export async function ensureFixedAssetAccounts(db: Db, createdBy?: unknown, session?: ClientSession) {
  const now = new Date();
  await db.collection("chartOfAccounts").bulkWrite(FIXED_ASSET_ACCOUNTS.map(account => ({
    updateOne: {
      filter: { code: account.code },
      update: { $setOnInsert: { ...account, active: true, createdBy: createdBy || null, createdAt: now } },
      upsert: true,
    },
  })), session ? { session } : undefined);
}
