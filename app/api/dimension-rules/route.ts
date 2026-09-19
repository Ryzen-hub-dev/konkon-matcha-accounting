import { ObjectId, type ClientSession, type Db } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { dimensionRuleCreateSchema, dimensionRuleUpdateSchema, effectiveRuleAllocations, normaliseDimensionRuleMatchKey, type DimensionRuleSource } from "@/lib/dimension-allocation";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";
import { hasPermission } from "@/lib/rbac";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";

export const runtime = "nodejs";

class DimensionRuleConflictError extends Error {}
class DimensionRuleValidationError extends Error {}

async function resolveTarget(db: Db, source: DimensionRuleSource, matchKey: string, session?: ClientSession) {
  if (source === "EXPENSE_ACCOUNT") {
    const account = await db.collection("chartOfAccounts").findOne({ code: matchKey, type: "EXPENSE", active: { $ne: false } }, session ? { session } : undefined);
    if (!account) throw new DimensionRuleValidationError("Choose an active expense account for this rule.");
    return { id: String(account.code), code: String(account.code), name: String(account.name) };
  }
  if (!ObjectId.isValid(matchKey)) throw new DimensionRuleValidationError("Choose a valid location for this rule.");
  const location = await db.collection("locations").findOne({ _id: new ObjectId(matchKey), active: { $ne: false } }, session ? { session } : undefined);
  if (!location) throw new DimensionRuleValidationError("Choose an active location for this rule.");
  return { id: location._id.toHexString(), code: String(location.code), name: String(location.name) };
}

async function resolveAllocations(db: Db, allocations: Array<{ costCentreId?: string; projectId?: string; percentage: number }>, session?: ClientSession) {
  const requested = [...new Set(allocations.flatMap(allocation => [allocation.costCentreId, allocation.projectId]).filter((id): id is string => Boolean(id)))];
  if (!requested.length || requested.some(id => !ObjectId.isValid(id))) throw new DimensionRuleValidationError("Choose active dimensions for every allocation split.");
  const dimensions = await db.collection("accountingDimensions").find({ _id: { $in: requested.map(id => new ObjectId(id)) }, active: { $ne: false } }, session ? { session } : undefined).project({ type: 1, code: 1, name: 1 }).toArray();
  return allocations.map(allocation => {
    const costCentre = allocation.costCentreId ? dimensions.find(item => String(item._id) === allocation.costCentreId && item.type === "COST_CENTRE") : null;
    const project = allocation.projectId ? dimensions.find(item => String(item._id) === allocation.projectId && item.type === "PROJECT") : null;
    if ((allocation.costCentreId && !costCentre) || (allocation.projectId && !project) || (!costCentre && !project)) throw new DimensionRuleValidationError("A selected cost centre or project is inactive or has the wrong type.");
    return {
      percentage: allocation.percentage,
      ...(costCentre ? { costCentreId: costCentre._id, costCentreCode: String(costCentre.code), costCentreName: String(costCentre.name) } : {}),
      ...(project ? { projectId: project._id, projectCode: String(project.code), projectName: String(project.name) } : {}),
    };
  });
}

function safeRule(rule: Record<string, any>) {
  const allocations = Array.isArray(rule.allocations) && rule.allocations.length ? rule.allocations : [{ percentage: 100, costCentreId: rule.costCentreId, costCentreCode: rule.costCentreCode, costCentreName: rule.costCentreName, projectId: rule.projectId, projectCode: rule.projectCode, projectName: rule.projectName }];
  return {
    _id: rule._id,
    source: rule.source,
    matchKey: rule.matchKey,
    matchCode: rule.matchCode,
    matchName: rule.matchName,
    costCentre: rule.costCentreId ? { id: rule.costCentreId, code: rule.costCentreCode, name: rule.costCentreName } : null,
    project: rule.projectId ? { id: rule.projectId, code: rule.projectCode, name: rule.projectName } : null,
    allocations: allocations.map((allocation: Record<string, any>) => ({ percentage: Number(allocation.percentage), costCentre: allocation.costCentreId ? { id: allocation.costCentreId, code: allocation.costCentreCode, name: allocation.costCentreName } : null, project: allocation.projectId ? { id: allocation.projectId, code: allocation.projectCode, name: allocation.projectName } : null })),
    active: rule.active !== false,
    version: Number(rule.version || 1),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export async function GET() {
  const auth = await authorize("reports.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [rules, dimensions, locations, expenseAccounts] = await Promise.all([
      db.collection("dimensionAllocationRules").find({}).sort({ active: -1, source: 1, matchCode: 1 }).toArray(),
      db.collection("accountingDimensions").find({}).project({ type: 1, code: 1, name: 1, active: 1 }).sort({ type: 1, code: 1 }).toArray(),
      db.collection("locations").find({ active: { $ne: false } }).project({ code: 1, name: 1 }).sort({ code: 1 }).toArray(),
      db.collection("chartOfAccounts").find({ type: "EXPENSE", active: { $ne: false } }).project({ code: 1, name: 1 }).sort({ code: 1 }).toArray(),
    ]);
    return ok(serialise({
      permissions: { manage: hasPermission(auth.session.role, "accounting.write") },
      rules: rules.map(safeRule),
      dimensions: dimensions.map(item => ({ _id: item._id, type: item.type, code: item.code, name: item.name, active: item.active !== false })),
      targets: {
        locations: locations.map(item => ({ id: item._id, code: item.code, name: item.name })),
        expenseAccounts: expenseAccounts.map(item => ({ id: item.code, code: item.code, name: item.name })),
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
    const parsed = dimensionRuleCreateSchema.safeParse(body);
    if (!parsed.success) return fail("Check the allocation rule.", 422, parsed.error.flatten().fieldErrors);
    const db = await getDb(), client = await getMongoClient(), session = client.startSession();
    const _id = new ObjectId(), now = new Date(), matchKey = normaliseDimensionRuleMatchKey(parsed.data.source, parsed.data.matchKey);
    let document: Record<string, any> = {};
    try {
      await session.withTransaction(async () => {
        await touchBusinessKeyLock(db, businessKeyLockId("DIMENSION_RULE", parsed.data.source, matchKey), session, now);
        if (await db.collection("dimensionAllocationRules").findOne({ source: parsed.data.source, matchKey }, { projection: { _id: 1 }, session })) {
          throw new DimensionRuleConflictError("An allocation rule already exists for this source and target.");
        }
        const requestedAllocations = effectiveRuleAllocations(parsed.data);
        const [target, allocations] = await Promise.all([
          resolveTarget(db, parsed.data.source, matchKey, session),
          resolveAllocations(db, requestedAllocations, session),
        ]);
        document = {
          source: parsed.data.source, matchKey, matchCode: target.code, matchName: target.name, allocations,
          active: true, version: 1, createdAt: now, updatedAt: now, createdBy: new ObjectId(auth.session.id), updatedBy: new ObjectId(auth.session.id),
          history: [{ action: "CREATED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }],
        };
        await db.collection("dimensionAllocationRules").insertOne({ _id, ...document }, { session });
        await writeAudit(db, auth.session, "dimension-rule.create", "dimensionAllocationRule", _id.toHexString(), { source: parsed.data.source, matchKey, matchName: target.name, allocationCount: allocations.length }, session);
      });
    } finally { await session.endSession(); }
    return created(serialise(safeRule({ _id, ...document })));
  } catch (error) {
    if (error instanceof DimensionRuleConflictError) return fail(error.message, 409);
    if (error instanceof DimensionRuleValidationError) return fail(error.message, 422);
    if ((error as { code?: number }).code === 11000) return fail("An allocation rule already exists for this source and target.", 409);
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
    const parsed = dimensionRuleUpdateSchema.safeParse(body);
    if (!parsed.success || !ObjectId.isValid(parsed.data?.id || "")) return fail("Check the allocation rule.", 422, parsed.success ? undefined : parsed.error.flatten().fieldErrors);
    const input = parsed.data, db = await getDb(), client = await getMongoClient(), session = client.startSession(), now = new Date(), id = new ObjectId(input.id);
    let updated: Record<string, any> | null = null;
    try {
      await session.withTransaction(async () => {
        const current = await db.collection("dimensionAllocationRules").findOne({ _id: id, version: input.expectedVersion }, { session });
        if (!current) throw new DimensionRuleConflictError("This allocation rule changed in another session. Reload and try again.");
        if (input.active) await resolveTarget(db, current.source as DimensionRuleSource, String(current.matchKey), session);
        const allocations = await resolveAllocations(db, effectiveRuleAllocations(input), session);
        updated = await db.collection("dimensionAllocationRules").findOneAndUpdate(
          { _id: id, version: input.expectedVersion },
          { $set: { allocations, active: input.active, updatedAt: now, updatedBy: new ObjectId(auth.session.id), history: [...(Array.isArray(current.history) ? current.history : []), { action: input.active ? "SAVED_ACTIVE" : "ARCHIVED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }] }, $unset: { deactivatedByDimensionId: "", costCentreId: "", costCentreCode: "", costCentreName: "", projectId: "", projectCode: "", projectName: "" }, $inc: { version: 1 } },
          { returnDocument: "after", session },
        );
        if (!updated) throw new DimensionRuleConflictError("This allocation rule changed while it was being saved.");
        await writeAudit(db, auth.session, input.active ? "dimension-rule.save" : "dimension-rule.archive", "dimensionAllocationRule", input.id, { source: current.source, matchKey: current.matchKey, allocationCount: allocations.length }, session);
      });
    } finally { await session.endSession(); }
    return ok(serialise(safeRule(updated!)));
  } catch (error) {
    if (error instanceof DimensionRuleConflictError) return fail(error.message, 409);
    if (error instanceof DimensionRuleValidationError) return fail(error.message, 422);
    return publicError(error);
  }
}
