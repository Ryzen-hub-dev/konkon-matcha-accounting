import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

const createSchema = z.object({ targetUserId: z.string().length(24) });
const actionSchema = z.object({ id: z.string().length(24), action: z.enum(["CANCEL", "COMPLETE"]) });
const COOLING_PERIOD_MS = 24 * 60 * 60 * 1000;

async function owner(request?: Request) {
  const auth = await authorize("team.write");
  if (auth.error) return auth;
  if (auth.session.role !== "OWNER") return { error: fail("Only the current Owner can transfer ownership.", 403) } as const;
  if (request && !sameOrigin(request)) return { error: fail("This request was blocked.", 403) } as const;
  return auth;
}

export async function GET() {
  const auth = await owner();
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [pending, targets] = await Promise.all([
      db.collection("ownershipTransfers").findOne({ status: "PENDING" }, { sort: { createdAt: -1 } }),
      db.collection("users").find({ _id: { $ne: new ObjectId(auth.session.id) }, active: true, archivedAt: { $exists: false }, role: { $ne: "OWNER" } }, { projection: { passwordHash: 0, usernameNormalized: 0, emailNormalized: 0 } }).sort({ fullName: 1 }).toArray(),
    ]);
    return ok(serialise({ pending, targets, coolingPeriodHours: 24 }));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await owner(request);
  if (auth.error) return auth.error;
  try {
    const input = createSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.targetUserId)) return fail("Choose an eligible new Owner.", 422);
    const db = await getDb();
    if (await db.collection("ownershipTransfers").findOne({ status: "PENDING" })) return fail("An ownership transfer is already cooling off.", 409);
    const target = await db.collection("users").findOne({ _id: new ObjectId(input.data.targetUserId), active: true, archivedAt: { $exists: false }, role: { $ne: "OWNER" } });
    if (!target) return fail("The selected account is not eligible for ownership.", 409);
    const now = new Date();
    const transfer = {
      fromUserId: new ObjectId(auth.session.id),
      fromName: auth.session.fullName,
      targetUserId: target._id,
      targetName: target.fullName,
      status: "PENDING",
      executeAfter: new Date(now.getTime() + COOLING_PERIOD_MS),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("ownershipTransfers").insertOne(transfer);
    await writeAudit(db, auth.session, "ownership.request", "ownershipTransfer", result.insertedId.toHexString(), { targetUserId: input.data.targetUserId, executeAfter: transfer.executeAfter });
    return created(serialise({ _id: result.insertedId, ...transfer }));
  } catch (error) {
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await owner(request);
  if (auth.error) return auth.error;
  try {
    const input = actionSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the transfer action.", 422);
    const db = await getDb();
    const transfer = await db.collection("ownershipTransfers").findOne({ _id: new ObjectId(input.data.id), status: "PENDING", fromUserId: new ObjectId(auth.session.id) });
    if (!transfer) return fail("The pending transfer could not be found.", 404);
    const now = new Date();
    if (input.data.action === "CANCEL") {
      await db.collection("ownershipTransfers").updateOne({ _id: transfer._id, status: "PENDING" }, { $set: { status: "CANCELLED", cancelledAt: now, updatedAt: now } });
      await writeAudit(db, auth.session, "ownership.cancel", "ownershipTransfer", input.data.id);
      return ok({ cancelled: true });
    }
    if (!(transfer.executeAfter instanceof Date) || transfer.executeAfter > now) {
      return fail("The 24-hour cooling-off period has not ended.", 409);
    }
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        const target = await db.collection("users").findOne({ _id: transfer.targetUserId, active: true, archivedAt: { $exists: false } }, { session: mongoSession });
        if (!target) throw new Error("TRANSFER_TARGET_UNAVAILABLE");
        await db.collection("users").updateOne(
          { _id: new ObjectId(auth.session.id), role: "OWNER" },
          { $set: { role: "ADMIN", updatedAt: now }, $inc: { sessionVersion: 1 } },
          { session: mongoSession },
        );
        await db.collection("users").updateOne(
          { _id: target._id },
          { $set: { role: "OWNER", updatedAt: now }, $inc: { sessionVersion: 1 } },
          { session: mongoSession },
        );
        await db.collection("ownershipTransfers").updateOne(
          { _id: transfer._id, status: "PENDING" },
          { $set: { status: "COMPLETED", completedAt: now, updatedAt: now } },
          { session: mongoSession },
        );
        await writeAudit(db, auth.session, "ownership.complete", "ownershipTransfer", input.data.id, { targetUserId: String(target._id) }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return ok({ completed: true, signInAgain: true });
  } catch (error) {
    if (error instanceof Error && error.message === "TRANSFER_TARGET_UNAVAILABLE") return fail("The selected account is no longer eligible.", 409);
    return publicError(error);
  }
}
