import { ObjectId, type ClientSession, type Db } from "mongodb";

// Keep stable record IDs for accounting references, not reusable credentials or contacts.
export async function clearArchivedMember(db: Db, id: ObjectId, now: Date, session?: ClientSession) {
  const options = session ? { session } : {};
  const result = await db.collection("members").updateOne(
    { _id: id, active: false, archivedAt: { $exists: true } },
    { $set: { name: "Deleted member" }, $unset: { phone: "", email: "", identityLookupHash: "", identityLast4: "", identityType: "", memberCardCode: "" } }, options,
  );
  if (!result.matchedCount) return false;
  await db.collection("memberCards").updateMany(
    { memberId: id, kind: { $ne: "BOUND" }, status: { $ne: "DELETED" } },
    { $set: { status: "VOID", updatedAt: now }, $unset: { encryptedToken: "", tokenHash: "" } }, options,
  );
  // Bound cards stay discoverable by their non-reversible fingerprint for the
  // guarded orphan-card clear/rebind workflow; they cannot identify a live member.
  await db.collection("scannerSessions").updateMany(
    { purpose: "MEMBER_BIND", bindingMemberId: id.toHexString() },
    { $set: { revokedAt: now, expiresAt: now } }, options,
  );
  await db.collection("members").updateOne({ _id: id, active: false }, { $set: { personalDataClearedAt: now } }, options);
  return true;
}

export async function clearArchivedUser(db: Db, id: ObjectId, now: Date, session?: ClientSession) {
  const options = session ? { session } : {};
  const result = await db.collection("users").updateOne(
    { _id: id, active: false, archivedAt: { $exists: true }, role: { $ne: "OWNER" } },
    { $set: { fullName: "Deleted staff", username: `deleted-${id.toHexString()}`, usernameNormalized: `deleted:${id.toHexString()}` }, $unset: { passwordHash: "", email: "", emailNormalized: "", mustChangePassword: "", selectionTokenHash: "", encryptedSelectionToken: "", selectionTokenLast4: "" } }, options,
  );
  if (!result.matchedCount) return false;
  for (const collection of ["scannerSessions", "paymentDisplaySessions"]) {
    await db.collection(collection).updateMany({ createdBy: id }, { $set: { revokedAt: now, expiresAt: now } }, options);
  }
  await db.collection("users").updateOne({ _id: id, active: false }, { $set: { personalDataClearedAt: now } }, options);
  return true;
}
