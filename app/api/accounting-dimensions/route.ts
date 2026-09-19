import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { buildDimensionReport, dimensionCreateSchema, dimensionUpdateSchema, type AccountingDimensionType, type DimensionMaster, type DimensionMovement } from "@/lib/accounting-dimensions";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone, isValidDateKey, journalReportDateExpression, shiftDateKey } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";
import { hasPermission } from "@/lib/rbac";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";

export const runtime = "nodejs";

class DimensionConflictError extends Error {}

function safeDimension(dimension: Record<string, any> | null | undefined) {
  if (!dimension) return null;
  return {
    _id: dimension._id,
    type: dimension.type,
    code: dimension.code,
    name: dimension.name,
    description: dimension.description || "",
    active: dimension.active !== false,
    version: dimension.version,
    createdAt: dimension.createdAt,
    updatedAt: dimension.updatedAt,
  };
}

function periodBoundary(value: string, offset: number) {
  return new Date(`${shiftDateKey(value, offset)}T00:00:00.000Z`);
}

function groupedMovements(documents: Array<Record<string, any>>): DimensionMovement[] {
  return documents.map(document => ({
    code: String(document._id?.code || ""),
    name: String(document._id?.name || ""),
    accountCode: String(document._id?.accountCode || ""),
    debit: Number(document.debit || 0),
    credit: Number(document.credit || 0),
    activity: Number(document.activity || 0),
    lineCount: Number(document.lineCount || 0),
  }));
}

export async function GET(request: Request) {
  const auth = await authorize("reports.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    if (url.searchParams.get("choices") === "1") {
      const dimensions = await db.collection("accountingDimensions").find({}).sort({ type: 1, active: -1, code: 1 }).project({ type: 1, code: 1, name: 1, active: 1 }).toArray();
      return ok(serialise({ dimensions: dimensions.map(safeDimension) }));
    }
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const today = dateKeyInTimeZone(new Date(), settings.timeZone);
    const from = url.searchParams.get("from") || `${today.slice(0, 8)}01`;
    const to = url.searchParams.get("to") || today;
    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) return fail("Choose a valid reporting period.", 422);
    const days = Math.floor((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
    if (days > 3_653) return fail("Choose a reporting period of 10 years or less.", 422);

    const [dimensionDocuments, accountDocuments] = await Promise.all([
      db.collection("accountingDimensions").find({}).sort({ type: 1, active: -1, code: 1 }).toArray(),
      db.collection("chartOfAccounts").find({ type: { $in: ["REVENUE", "EXPENSE"] } }).project({ code: 1, type: 1 }).toArray(),
    ]);
    const accountCodes = accountDocuments.map(account => String(account.code));
    const facets = accountCodes.length ? await db.collection("journalEntries").aggregate([
      { $match: { status: "POSTED", date: { $gte: periodBoundary(from, -2), $lt: periodBoundary(to, 2) } } },
      { $addFields: { _dimensionReportDate: journalReportDateExpression(settings.timeZone) } },
      { $match: { _dimensionReportDate: { $gte: from, $lte: to } } },
      { $unwind: "$lines" },
      { $match: { "lines.accountCode": { $in: accountCodes } } },
      { $facet: {
        costCentres: [{ $group: {
          _id: { code: { $ifNull: ["$lines.costCentre.code", ""] }, name: { $ifNull: ["$lines.costCentre.name", ""] }, accountCode: "$lines.accountCode" },
          debit: { $sum: { $ifNull: ["$lines.debit", 0] } }, credit: { $sum: { $ifNull: ["$lines.credit", 0] } },
          activity: { $sum: { $add: [{ $ifNull: ["$lines.debit", 0] }, { $ifNull: ["$lines.credit", 0] }] } }, lineCount: { $sum: 1 },
        } }],
        projects: [{ $group: {
          _id: { code: { $ifNull: ["$lines.project.code", ""] }, name: { $ifNull: ["$lines.project.name", ""] }, accountCode: "$lines.accountCode" },
          debit: { $sum: { $ifNull: ["$lines.debit", 0] } }, credit: { $sum: { $ifNull: ["$lines.credit", 0] } },
          activity: { $sum: { $add: [{ $ifNull: ["$lines.debit", 0] }, { $ifNull: ["$lines.credit", 0] }] } }, lineCount: { $sum: 1 },
        } }],
      } },
    ]).next() : { costCentres: [], projects: [] };

    const dimensions: DimensionMaster[] = dimensionDocuments.map(dimension => ({
      type: String(dimension.type) as AccountingDimensionType,
      code: String(dimension.code),
      name: String(dimension.name),
      active: dimension.active !== false,
    }));
    const accountTypes = new Map(accountDocuments.map(account => [String(account.code), String(account.type) as "REVENUE" | "EXPENSE"]));
    return ok(serialise({
      period: { from, to, days, currency: settings.currency, timeZone: settings.timeZone },
      permissions: { manage: hasPermission(auth.session.role, "accounting.write") },
      dimensions: dimensionDocuments.map(safeDimension),
      reports: {
        costCentres: buildDimensionReport("COST_CENTRE", dimensions, groupedMovements(facets?.costCentres || []), accountTypes, settings.currency),
        projects: buildDimensionReport("PROJECT", dimensions, groupedMovements(facets?.projects || []), accountTypes, settings.currency),
      },
    }));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return fail("The request body must be valid JSON.", 400); }
    const parsed = dimensionCreateSchema.safeParse(body);
    if (!parsed.success) return fail("Check the tracking dimension.", 422, parsed.error.flatten().fieldErrors);
    const db = await getDb();
    const client = await getMongoClient();
    const session = client.startSession();
    const _id = new ObjectId(), now = new Date();
    const document = { ...parsed.data, active: true, version: 1, createdAt: now, updatedAt: now, createdBy: new ObjectId(auth.session.id), updatedBy: new ObjectId(auth.session.id) };
    try {
      await session.withTransaction(async () => {
        await touchBusinessKeyLock(db, businessKeyLockId("ACCOUNTING_DIMENSION", document.type, document.code), session, now);
        if (await db.collection("accountingDimensions").findOne({ type: document.type, code: document.code }, { projection: { _id: 1 }, session })) {
          throw new DimensionConflictError("That code already exists for this dimension type.");
        }
        await db.collection("accountingDimensions").insertOne({ _id, ...document }, { session });
        await writeAudit(db, auth.session, "accounting-dimension.create", "accountingDimension", _id.toHexString(), { type: document.type, code: document.code, name: document.name }, session);
      });
    } finally { await session.endSession(); }
    return created(serialise(safeDimension({ _id, ...document })));
  } catch (error) {
    if (error instanceof DimensionConflictError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("That code already exists for this dimension type.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return fail("The request body must be valid JSON.", 400); }
    const parsed = dimensionUpdateSchema.safeParse(body);
    if (!parsed.success || !ObjectId.isValid(parsed.data?.id || "")) return fail("Check the tracking dimension.", 422, parsed.success ? undefined : parsed.error.flatten().fieldErrors);
    const input = parsed.data, db = await getDb(), id = new ObjectId(input.id), now = new Date();
    const client = await getMongoClient(), session = client.startSession();
    let updated: Record<string, any> | null = null;
    let disabledRuleCount = 0;
    try {
      await session.withTransaction(async () => {
        const current = await db.collection("accountingDimensions").findOne({ _id: id, version: input.expectedVersion }, { session });
        if (!current) throw new DimensionConflictError("This dimension changed in another session. Reload and try again.");
        updated = await db.collection("accountingDimensions").findOneAndUpdate(
          { _id: id, version: input.expectedVersion },
          { $set: { name: input.name, description: input.description, active: input.active, updatedAt: now, updatedBy: new ObjectId(auth.session.id) }, $inc: { version: 1 } },
          { returnDocument: "after", session },
        );
        if (!updated) throw new DimensionConflictError("This dimension changed while it was being saved.");
        const action = current.active !== false && !input.active ? "archive" : current.active === false && input.active ? "restore" : "update";
        if (action === "archive") {
          const disabled = await db.collection("dimensionAllocationRules").updateMany(
            { active: true, $or: [{ costCentreId: id }, { projectId: id }, { "allocations.costCentreId": id }, { "allocations.projectId": id }] },
            { $set: { active: false, updatedAt: now, updatedBy: new ObjectId(auth.session.id), deactivatedByDimensionId: id }, $inc: { version: 1 } },
            { session },
          );
          disabledRuleCount = disabled.modifiedCount;
        }
        await writeAudit(db, auth.session, `accounting-dimension.${action}`, "accountingDimension", input.id, { type: current.type, code: current.code, name: input.name, disabledRuleCount }, session);
      });
    } finally { await session.endSession(); }
    return ok(serialise(safeDimension(updated)));
  } catch (error) {
    if (error instanceof DimensionConflictError) return fail(error.message, 409);
    return publicError(error);
  }
}
