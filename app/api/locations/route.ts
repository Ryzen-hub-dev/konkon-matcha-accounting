import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { locationFields, locationParentChainIsValid, locationUpdateSchema } from "@/lib/locations";

export const runtime = "nodejs";

const archiveSchema = z.object({ id: z.string().length(24) });

async function ensureHeadquarters() {
  const db = await getDb();
  const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
  const now = new Date();
  await db.collection("locations").updateOne(
    { systemKey: "HEADQUARTERS" },
    { $setOnInsert: { code: "HQ", name: `${business.businessName} HQ`, type: "HEADQUARTERS", countryCode: business.countryCode, timeZone: business.timeZone, locale: business.locale, currency: business.currency, address: business.address, active: true, systemKey: "HEADQUARTERS", createdAt: now, updatedAt: now } },
    { upsert: true },
  );
  return db;
}

async function parentDetails(db: Awaited<ReturnType<typeof getDb>>, parentLocationId: string, ownId = "") {
  if (!parentLocationId) return null;
  if (!ObjectId.isValid(parentLocationId) || parentLocationId === ownId) throw new Error("INVALID_PARENT");
  const parent = await db.collection("locations").findOne({ _id: new ObjectId(parentLocationId), active: { $ne: false } });
  if (!parent) throw new Error("INVALID_PARENT");
  const validChain = await locationParentChainIsValid(parent._id.toHexString(), ownId, async (id) => {
    if (!ObjectId.isValid(id)) return undefined;
    const ancestor = await db.collection("locations").findOne({ _id: new ObjectId(id) }, { projection: { parentLocationId: 1 } });
    if (!ancestor) return undefined;
    return ancestor.parentLocationId ? String(ancestor.parentLocationId) : null;
  });
  if (!validChain) throw new Error("INVALID_PARENT");
  return { parentLocationId: parent._id, parentLocationName: String(parent.name) };
}

export async function GET(request: Request) {
  const auth = await authorize("settings.read");
  if (auth.error) return auth.error;
  try {
    const db = await ensureHeadquarters();
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "1";
    const locations = await db.collection("locations").find(includeArchived ? {} : { active: { $ne: false } }).sort({ active: -1, type: 1, code: 1 }).toArray();
    const response = ok(serialise(locations));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("settings.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = locationFields.safeParse(await request.json());
    if (!input.success) return fail("Check the location details.", 422, input.error.flatten().fieldErrors);
    const db = await ensureHeadquarters();
    const parent = await parentDetails(db, input.data.parentLocationId);
    const now = new Date();
    const document = { ...input.data, ...parent, parentLocationId: parent?.parentLocationId || null, active: true, createdBy: new ObjectId(auth.session.id), createdAt: now, updatedAt: now };
    const result = await db.collection("locations").insertOne(document);
    await writeAudit(db, auth.session, "location.create", "location", result.insertedId.toHexString(), { code: document.code, type: document.type, countryCode: document.countryCode });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as Error).message === "INVALID_PARENT") return fail("Choose an active parent location.", 422);
    if ((error as { code?: number }).code === 11000) return fail("That location code is already in use.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("settings.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = locationUpdateSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the location update.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const db = await ensureHeadquarters();
    const current = await db.collection("locations").findOne({ _id: new ObjectId(input.data.id) });
    if (!current) return fail("This location could not be found.", 404);
    const { id, parentLocationId, ...changes } = input.data;
    if (current.systemKey === "HEADQUARTERS" && (
      changes.active === false
      || (changes.code !== undefined && changes.code !== current.code)
      || (changes.type !== undefined && changes.type !== "HEADQUARTERS")
      || Boolean(parentLocationId)
    )) return fail("The primary headquarters code, type, parent and active status are protected.", 409);
    if (changes.active === false && await db.collection("locations").countDocuments({ parentLocationId: current._id, active: { $ne: false } })) {
      return fail("Move or archive child locations before deactivating this parent.", 409);
    }
    const parent = parentLocationId === undefined ? null : await parentDetails(db, parentLocationId, id);
    if (changes.active === true && parentLocationId === undefined && current.parentLocationId) {
      const activeParent = await db.collection("locations").findOne({ _id: current.parentLocationId, active: { $ne: false } });
      if (!activeParent) return fail("Restore the parent location before restoring this child.", 409);
    }
    const update = { ...changes, ...(parentLocationId !== undefined ? { ...parent, parentLocationId: parent?.parentLocationId || null, parentLocationName: parent?.parentLocationName || "" } : {}), updatedAt: new Date(), updatedBy: new ObjectId(auth.session.id) };
    const saved = await db.collection("locations").findOneAndUpdate({ _id: current._id }, { $set: update }, { returnDocument: "after" });
    await writeAudit(db, auth.session, "location.update", "location", id, { fields: Object.keys(update).filter((field) => !field.startsWith("updated")) });
    return ok(serialise(saved));
  } catch (error) {
    if ((error as Error).message === "INVALID_PARENT") return fail("A location cannot parent itself and must use an active parent.", 422);
    if ((error as { code?: number }).code === 11000) return fail("That location code is already in use.", 409);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("settings.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = archiveSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the location reference.", 422);
    const db = await ensureHeadquarters();
    const id = new ObjectId(input.data.id);
    const current = await db.collection("locations").findOne({ _id: id, active: { $ne: false } });
    if (!current) return fail("This location is already inactive.", 404);
    if (current.systemKey === "HEADQUARTERS") return fail("The primary headquarters cannot be archived.", 409);
    if (await db.collection("locations").countDocuments({ parentLocationId: id, active: { $ne: false } })) return fail("Move or archive child locations before archiving this parent.", 409);
    const now = new Date();
    await db.collection("locations").updateOne({ _id: id }, { $set: { active: false, archivedAt: now, archivedBy: new ObjectId(auth.session.id), updatedAt: now } });
    await writeAudit(db, auth.session, "location.archive", "location", input.data.id, { code: current.code });
    return ok({ archived: true });
  } catch (error) { return publicError(error); }
}
