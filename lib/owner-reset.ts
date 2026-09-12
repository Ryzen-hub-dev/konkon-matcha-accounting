import { createHash, randomBytes } from "node:crypto";
import { ObjectId, type Db, type MongoClient } from "mongodb";

/** Offline maintenance only. Never expose this operation through a public API. */
export async function resetOwnerForRecovery(db: Db, client: MongoClient, ownerId: string, now = new Date()) {
  if (!ObjectId.isValid(ownerId)) throw new Error("A verified Owner ID is required.");
  const id = new ObjectId(ownerId);
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const users = db.collection("users");
      const owner = await users.findOne({ _id: id, role: "OWNER" }, { session });
      if (!owner || await users.countDocuments({ role: "OWNER" }, { session }) !== 1) throw new Error("The exact sole Owner must still exist.");
      if (!await users.countDocuments({ role: { $ne: "OWNER" } }, { session, limit: 1 })) throw new Error("Retain another account so public first-run registration stays closed.");
      // Existing transfer completion must be handled before retiring its source.
      // Refuse rather than race an in-flight ownership promotion.
      const transfers = await db.collection("ownershipTransfers").countDocuments({ status: "PENDING" }, { session, limit: 1 });
      if (transfers) throw new Error("Resolve pending ownership transfers before resetting the Owner.");
      const previousGrant = await db.collection("ownerRecovery").findOne({ _id: "owner-recovery" as never }, { session });
      if (previousGrant?.status === "PENDING" && previousGrant.expiresAt > now) throw new Error("A recovery grant is already pending.");
      // Keep identity/history recoverable but permanently remove login credentials.
      await db.collection("archivedUsers").insertOne({
        _id: id, username: owner.username, fullName: owner.fullName, email: owner.email,
        role: owner.role, active: false, createdAt: owner.createdAt, archivedAt: now,
        archiveReason: "USER_REQUESTED_OWNER_REPLACEMENT", previousSessionVersion: owner.sessionVersion,
      }, { session });
      const removed = await users.deleteOne({ _id: id, role: "OWNER" }, { session });
      if (removed.deletedCount !== 1) throw new Error("Owner removal was not confirmed.");
      for (const name of ["scannerSessions", "paymentDisplaySessions"]) {
        await db.collection(name).updateMany({ createdBy: { $in: [id, id.toHexString()] }, revokedAt: { $exists: false } }, {
          $set: { revokedAt: now, updatedAt: now, revocationReason: "OWNER_ACCOUNT_REMOVED" },
        }, { session });
      }
      await db.collection("ownerRecovery").replaceOne({ _id: "owner-recovery" as never }, {
        _id: "owner-recovery" as never, tokenHash: createHash("sha256").update(token).digest("hex"),
        status: "PENDING", previousOwnerId: id, createdAt: now, expiresAt,
      }, { upsert: true, session });
      await db.collection("auditLogs").insertOne({
        actorId: "user-authorized-maintenance", actorName: "User-authorized maintenance", actorRole: "SYSTEM",
        action: "user.owner_removed_for_recovery", entityType: "user", entityId: id.toHexString(),
        details: { username: owner.username, profileArchivedWithoutCredentials: true, recoveryExpiresAt: expiresAt }, createdAt: now,
      }, { session });
    });
    return { token, expiresAt, removedOwnerId: id.toHexString() };
  } finally {
    await session.endSession();
  }
}
