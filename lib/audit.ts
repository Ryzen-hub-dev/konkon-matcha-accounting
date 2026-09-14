import { ObjectId, type Db, type ClientSession } from "mongodb";
import type { SessionPayload } from "@/lib/types";
import { auditExpiry } from "./data-retention";

export async function writeAudit(
  db: Db,
  actor: SessionPayload | { id: string; username: string; fullName: string; role: string },
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
  session?: ClientSession,
) {
  const createdAt = new Date();
  const expiresAt = auditExpiry(action, createdAt);
  await db.collection("auditLogs").insertOne(
    {
      actorId: ObjectId.isValid(actor.id) ? new ObjectId(actor.id) : actor.id,
      actorName: actor.fullName,
      actorRole: actor.role,
      action,
      entityType,
      entityId,
      details,
      createdAt,
      ...(expiresAt ? { expiresAt } : {}),
    },
    session ? { session } : undefined,
  );
}
