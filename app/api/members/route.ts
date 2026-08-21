import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { normalisePrivateIdentifier, privateIdentifierHash } from "@/lib/sensitive";

export const runtime = "nodejs";

const memberFields = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(24).regex(/^[0-9+() -]+$/),
  email: z.union([z.string().trim().email().max(160), z.literal("")]).default(""),
  identityType: z.string().trim().max(32).default("NATIONAL_ID"),
  identityNumber: z.string().trim().max(64).default(""),
});

const updateSchema = memberFields.partial().extend({
  id: z.string().length(24),
  regenerateCard: z.boolean().default(false),
});
const deleteSchema = z.object({ id: z.string().length(24) });
const safeProjection = { identityLookupHash: 0, createdBy: 0, archivedBy: 0 };

function escapedSearch(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeMemberCardCode() {
  return `KKM-M-${randomBytes(7).toString("hex").toUpperCase()}`;
}

function identityFields(identityType: string, identityNumber: string) {
  const normalised = normalisePrivateIdentifier(identityNumber);
  return normalised ? {
    identityType: identityType || "NATIONAL_ID",
    identityLookupHash: privateIdentifierHash(normalised),
    identityLast4: normalised.slice(-4),
  } : {};
}

export async function GET(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    if (url.searchParams.get("revision") === "1") {
      const [latest, count] = await Promise.all([
        db.collection("members").find({}, { projection: { updatedAt: 1, createdAt: 1 } }).sort({ updatedAt: -1, createdAt: -1 }).limit(1).next(),
        db.collection("members").countDocuments({ active: { $ne: false } }),
      ]);
      const response = ok({ revision: new Date(latest?.updatedAt || latest?.createdAt || 0).toISOString(), count });
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      return response;
    }
    const id = url.searchParams.get("id") || "";
    const identity = url.searchParams.get("identity")?.trim() || "";
    const q = url.searchParams.get("q")?.trim().slice(0, 80) || "";
    const includeArchived = url.searchParams.get("includeArchived") === "1" && ["OWNER", "ADMIN", "MANAGER"].includes(auth.session.role);
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The member reference is invalid.", 422);
      const member = await db.collection("members").findOne({ _id: new ObjectId(id), ...(includeArchived ? {} : { active: { $ne: false } }) }, { projection: safeProjection });
      return member ? ok(serialise(member)) : fail("The member could not be found.", 404);
    }
    const filter: Record<string, unknown> = includeArchived ? {} : { active: { $ne: false } };
    if (identity) {
      const now = new Date();
      const recentLookups = await db.collection("sensitiveLookupEvents").countDocuments({ actorId: new ObjectId(auth.session.id), createdAt: { $gt: new Date(now.getTime() - 60_000) } });
      if (recentLookups >= 20) return fail("Too many protected identity lookups. Wait one minute and try again.", 429);
      const hash = privateIdentifierHash(identity);
      if (!hash) return fail("Enter a complete identity number.", 422);
      filter.identityLookupHash = hash;
      await db.collection("sensitiveLookupEvents").insertOne({ actorId: new ObjectId(auth.session.id), createdAt: now, expiresAt: new Date(now.getTime() + 120_000) });
    } else if (q) {
      const search = escapedSearch(q);
      filter.$or = ["name", "phone", "email", "memberNo", "memberCardCode"].map((field) => ({ [field]: { $regex: search, $options: "i" } }));
    }
    const members = await db.collection("members").find(filter, { projection: safeProjection }).sort({ createdAt: -1 }).limit(500).toArray();
    if (identity) await writeAudit(db, auth.session, "member.identity_lookup", "member", members[0]?._id?.toHexString() || "no-match", { matched: members.length > 0 });
    return ok(serialise(members));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("members.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = memberFields.safeParse(await request.json());
    if (!input.success) return fail("Check the member details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const now = new Date();
    const document = {
      memberNo: makeDocumentNo("MEM"),
      memberCardCode: makeMemberCardCode(),
      name: input.data.name,
      phone: input.data.phone,
      email: input.data.email,
      ...identityFields(input.data.identityType, input.data.identityNumber),
      points: 0,
      lifetimeSpend: 0,
      active: true,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("members").insertOne(document);
    await writeAudit(db, auth.session, "member.create", "member", result.insertedId.toHexString(), { memberNo: document.memberNo, identityStored: Boolean(document.identityLast4) });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That phone number, identity number or member card is already registered.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("members.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = updateSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the member update.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const db = await getDb();
    const { id, regenerateCard, identityNumber, identityType, ...fields } = input.data;
    const set: Record<string, unknown> = { ...fields, ...(regenerateCard ? { memberCardCode: makeMemberCardCode() } : {}), updatedAt: new Date() };
    if (identityNumber) {
      const protectedFields = identityFields(identityType || "NATIONAL_ID", identityNumber);
      Object.assign(set, protectedFields);
    } else if (identityType !== undefined && !identityNumber) set.identityType = identityType;
    const member = await db.collection("members").findOneAndUpdate(
      { _id: new ObjectId(id), active: { $ne: false } },
      { $set: set },
      { returnDocument: "after", projection: safeProjection },
    );
    if (!member) return fail("The member no longer exists.", 404);
    await writeAudit(db, auth.session, "member.update", "member", id, { fields: Object.keys(set).filter((field) => field !== "updatedAt"), identityChanged: Boolean(identityNumber) });
    return ok(serialise(member));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That phone number, identity number or member card is already registered.", 409);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("members.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = deleteSchema.safeParse(await request.json());
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the member reference.", 422);
    const db = await getDb();
    const now = new Date();
    const member = await db.collection("members").findOneAndUpdate(
      { _id: new ObjectId(input.data.id), active: { $ne: false } },
      { $set: { active: false, archivedAt: now, archivedBy: new ObjectId(auth.session.id), updatedAt: now } },
      { returnDocument: "after", projection: safeProjection },
    );
    if (!member) return fail("The member no longer exists.", 404);
    await writeAudit(db, auth.session, "member.archive", "member", input.data.id, { memberNo: member.memberNo });
    return ok({ archived: true });
  } catch (error) {
    return publicError(error);
  }
}
