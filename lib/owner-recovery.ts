import { createHash, timingSafeEqual } from "node:crypto";
import { ObjectId, type Db, type MongoClient } from "mongodb";
import { z } from "zod";
import { hashPassword, normalizeIdentity } from "@/lib/auth";

export const OWNER_RECOVERY_ID = "owner-recovery";
export const OWNER_RECOVERY_MAX_BODY_BYTES = 16 * 1024;
export const ownerRecoveryTokenSchema = z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase());
export const ownerRecoveryClaimSchema = z.strictObject({
  action: z.literal("CLAIM"),
  token: ownerRecoveryTokenSchema,
  fullName: z.string().trim().min(2).max(100),
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.string().trim().email().max(160),
  password: z.string().min(12).max(128)
    .regex(/[a-z]/, "Include a lowercase letter")
    .regex(/[A-Z]/, "Include an uppercase letter")
    .regex(/[0-9]/, "Include a number")
    .refine(value => Buffer.byteLength(value, "utf8") <= 72, "Use a password of at most 72 UTF-8 bytes"),
});
export const ownerRecoveryRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("INSPECT"), token: ownerRecoveryTokenSchema }),
  ownerRecoveryClaimSchema,
]);
export type OwnerRecoveryClaim = z.infer<typeof ownerRecoveryClaimSchema>;
export interface OwnerRecoveryGrant {
  _id: string;
  tokenHash: string;
  status: "PENDING" | "CONSUMED" | "CANCELLED";
  expiresAt: Date;
  previousOwnerId: ObjectId;
  createdAt: Date;
  consumedAt?: Date;
  newOwnerId?: ObjectId;
}

export class OwnerRecoveryError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "OwnerRecoveryError";
  }
}

function unavailable() {
  return new OwnerRecoveryError("This Owner recovery link is invalid, expired, or already used.", 410);
}

export function hashOwnerRecoveryToken(token: string) {
  return createHash("sha256").update(ownerRecoveryTokenSchema.parse(token)).digest("hex");
}

export function isPendingOwnerRecovery(grant: OwnerRecoveryGrant | null, token: string, now = new Date()) {
  if (!grant || grant._id !== OWNER_RECOVERY_ID || grant.status !== "PENDING"
    || !(grant.expiresAt instanceof Date) || !(grant.expiresAt > now)
    || !/^[a-f0-9]{64}$/.test(grant.tokenHash) || !ownerRecoveryTokenSchema.safeParse(token).success) return false;
  return timingSafeEqual(Buffer.from(grant.tokenHash, "hex"), Buffer.from(hashOwnerRecoveryToken(token), "hex"));
}

function pendingFilter(token: string, now: Date) {
  return { _id: OWNER_RECOVERY_ID, tokenHash: hashOwnerRecoveryToken(token), status: "PENDING" as const, expiresAt: { $gt: now } };
}

export async function inspectOwnerRecovery(db: Db, token: string, now = new Date()) {
  if (!ownerRecoveryTokenSchema.safeParse(token).success) throw unavailable();
  const grant = await db.collection<OwnerRecoveryGrant>("ownerRecovery").findOne(pendingFilter(token, now));
  if (!isPendingOwnerRecovery(grant, token, now)) throw unavailable();
  // An inactive Owner still owns the workspace. Recovery never displaces one.
  if (await db.collection("users").countDocuments({ role: "OWNER" }, { limit: 1 })) throw unavailable();
  const business = await db.collection("settings").findOne({ key: "business" }, { projection: { businessName: 1 } });
  return { businessName: String(business?.businessName || "Your workspace"), expiresAt: grant!.expiresAt.toISOString() };
}

/** Consumes a pre-issued grant and creates only the replacement Owner, atomically. */
export async function claimOwnerRecovery(db: Db, client: MongoClient, value: OwnerRecoveryClaim) {
  const input = ownerRecoveryClaimSchema.parse(value);
  // Reject unknown/expired capabilities before doing expensive password hashing.
  await inspectOwnerRecovery(db, input.token);
  const passwordHash = await hashPassword(input.password);
  const _id = new ObjectId();
  const usernameNormalized = normalizeIdentity(input.username);
  const emailNormalized = normalizeIdentity(input.email);
  const user = {
    _id, username: input.username, usernameNormalized, email: input.email, emailNormalized,
    fullName: input.fullName, passwordHash, role: "OWNER" as const, active: true,
    sessionVersion: 1, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date(),
  };
  const mongoSession = client.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      const now = new Date();
      // All concurrent claims write this same fixed document. Only one may commit.
      // A later failure (including duplicate identity) rolls this consumption back.
      const grant = await db.collection<OwnerRecoveryGrant>("ownerRecovery").findOneAndUpdate(
        pendingFilter(input.token, now),
        { $set: { status: "CONSUMED", consumedAt: now, newOwnerId: _id } },
        { session: mongoSession, returnDocument: "before" },
      );
      if (!grant) throw unavailable();
      if (await db.collection("users").countDocuments({ role: "OWNER" }, { limit: 1, session: mongoSession })) throw unavailable();
      const duplicate = await db.collection("users").findOne(
        { $or: [{ usernameNormalized }, { emailNormalized }] },
        { projection: { _id: 1 }, session: mongoSession },
      );
      if (duplicate) throw new OwnerRecoveryError("That username or email is already in use. Choose another one.", 409);
      user.createdAt = now;
      user.updatedAt = now;
      await db.collection("users").insertOne(user, { session: mongoSession });
      await db.collection("auditLogs").insertOne({
        actorId: _id, actorName: user.fullName, actorRole: "OWNER", action: "owner.recovery.claimed",
        entityType: "user", entityId: _id.toHexString(),
        details: { previousOwnerId: grant.previousOwnerId.toHexString() }, createdAt: now,
      }, { session: mongoSession });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 11000) {
      throw new OwnerRecoveryError("That username or email is already in use. Choose another one.", 409);
    }
    throw error;
  } finally {
    await mongoSession.endSession();
  }
  return { id: _id.toHexString(), username: user.username, fullName: user.fullName, role: user.role, sessionVersion: 1, mustChangePassword: false };
}

/** Streaming limit also covers requests without an honest Content-Length header. */
export async function readOwnerRecoveryJson(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new OwnerRecoveryError("Send the request as JSON.", 415);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > OWNER_RECOVERY_MAX_BODY_BYTES) throw new OwnerRecoveryError("The request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new OwnerRecoveryError("The request body must be valid JSON.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OWNER_RECOVERY_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new OwnerRecoveryError("The request is too large.", 413);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new OwnerRecoveryError("The request body must be valid JSON.", 400);
    }
  } finally {
    reader.releaseLock();
  }
}
