import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { counterFields, counterUpdateSchema, ensureDefaultCounter } from "@/lib/counters";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";

const archiveSchema = z.object({ id: z.string().length(24) });

async function relatedRecords(db: Awaited<ReturnType<typeof getDb>>, locationId: string, managerIds: string[]) {
  if (!ObjectId.isValid(locationId) || managerIds.some((id) => !ObjectId.isValid(id))) throw new Error("INVALID_COUNTER_LINK");
  const [location, managers] = await Promise.all([
    db.collection("locations").findOne({ _id: new ObjectId(locationId), active: { $ne: false } }),
    managerIds.length ? db.collection("users").find({ _id: { $in: managerIds.map((id) => new ObjectId(id)) }, role: "MANAGER", active: true, archivedAt: { $exists: false } }, { projection: { fullName: 1 } }).toArray() : [],
  ]);
  if (!location || managers.length !== managerIds.length) throw new Error("INVALID_COUNTER_LINK");
  const managerMap = new Map(managers.map((manager) => [manager._id.toHexString(), String(manager.fullName)]));
  return {
    locationId: location._id,
    locationName: String(location.name),
    managerIds: managerIds.map((id) => new ObjectId(id)),
    managerNames: managerIds.map((id) => managerMap.get(id)!),
  };
}

export async function GET(request: Request) {
  const auth = await authorize("counters.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    await ensureDefaultCounter(db);
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "1" && hasPermission(auth.session.role, "counters.manage");
    const counters = await db.collection("counters").find(includeArchived ? {} : { active: { $ne: false } }).sort({ active: -1, locationName: 1, code: 1 }).limit(200).toArray();
    return ok(serialise(counters));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("counters.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = counterFields.safeParse(await request.json());
    if (!input.success) return fail("Check the counter details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    await ensureDefaultCounter(db);
    const links = await relatedRecords(db, input.data.locationId, input.data.managerIds);
    const now = new Date();
    const document = { code: input.data.code, name: input.data.name, ...links, active: true, createdBy: new ObjectId(auth.session.id), createdAt: now, updatedAt: now };
    const result = await db.collection("counters").insertOne(document);
    await writeAudit(db, auth.session, "counter.create", "counter", result.insertedId.toHexString(), { code: document.code, locationId: input.data.locationId, managerIds: input.data.managerIds });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as Error).message === "INVALID_COUNTER_LINK") return fail("Choose an active location and active Manager accounts.", 422);
    if ((error as { code?: number }).code === 11000) return fail("That counter code is already in use.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("counters.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = counterUpdateSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the counter update.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const db = await getDb();
    const current = await db.collection("counters").findOne({ _id: new ObjectId(input.data.id) });
    if (!current) return fail("This counter could not be found.", 404);
    const { id, managerIds, locationId, ...plainChanges } = input.data;
    if (current.systemKey === "PRIMARY" && (plainChanges.active === false || (plainChanges.code && plainChanges.code !== current.code))) return fail("The primary counter code and active status are protected.", 409);
    const nextLocationId = locationId ?? String(current.locationId);
    const nextManagerIds = managerIds ?? (current.managerIds || []).map(String);
    const links = await relatedRecords(db, nextLocationId, nextManagerIds);
    const update = { ...plainChanges, ...links, updatedBy: new ObjectId(auth.session.id), updatedAt: new Date() };
    const saved = await db.collection("counters").findOneAndUpdate({ _id: current._id }, { $set: update }, { returnDocument: "after" });
    await writeAudit(db, auth.session, "counter.update", "counter", id, { code: saved?.code, locationId: nextLocationId, managerIds: nextManagerIds });
    return ok(serialise(saved));
  } catch (error) {
    if ((error as Error).message === "INVALID_COUNTER_LINK") return fail("Choose an active location and active Manager accounts.", 422);
    if ((error as { code?: number }).code === 11000) return fail("That counter code is already in use.", 409);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("counters.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = archiveSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the counter reference.", 422);
    const db = await getDb();
    const counter = await db.collection("counters").findOne({ _id: new ObjectId(input.data.id), active: { $ne: false } });
    if (!counter) return fail("This counter is already inactive.", 404);
    if (counter.systemKey === "PRIMARY") return fail("The primary counter cannot be archived.", 409);
    const now = new Date();
    await db.collection("counters").updateOne({ _id: counter._id, active: { $ne: false } }, { $set: { active: false, archivedAt: now, archivedBy: new ObjectId(auth.session.id), updatedAt: now } });
    await writeAudit(db, auth.session, "counter.archive", "counter", input.data.id, { code: counter.code });
    return ok({ archived: true });
  } catch (error) { return publicError(error); }
}
