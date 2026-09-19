import type { ClientSession, Db } from "mongodb";

export function businessKeyLockId(namespace: string, ...parts: Array<string | number>) {
  const values = [namespace, ...parts.map(String)].map(value => encodeURIComponent(value.trim().toUpperCase()));
  return values.join(":").slice(0, 240);
}

export async function touchBusinessKeyLock(db: Db, id: string, session: ClientSession, now = new Date()) {
  await db.collection("businessKeyLocks").updateOne(
    { _id: id as never },
    { $set: { updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true, session },
  );
}
