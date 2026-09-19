import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { budgetActionSchema, budgetActual, budgetCreateSchema, budgetVariance, budgetYtdMonths, canApproveBudget, type BudgetAccountType, validateBudgetPrecision } from "@/lib/budgets";
import { dateKeyInTimeZone, journalReportDateExpression } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";
import { roundCurrency } from "@/lib/international";
import { hasPermission } from "@/lib/rbac";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";

export const runtime = "nodejs";
type BudgetLine = { accountCode: string; accountName: string; accountType: BudgetAccountType; monthly: number[] };
class BudgetConflictError extends Error {}

function safeBudgetPlan(plan: Record<string, any> | null | undefined) {
  if (!plan) return null;
  return {
    _id: plan._id,
    year: plan.year,
    revision: plan.revision,
    name: plan.name,
    notes: plan.notes,
    status: plan.status,
    version: plan.version,
    updatedAt: plan.updatedAt,
    approvedAt: plan.approvedAt,
    approvedByName: plan.approvedByName,
    approvalNote: plan.approvalNote,
  };
}

function parseYear(value: string | null, fallback: number) {
  const year = value ? Number(value) : fallback;
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : 0;
}

export async function GET(request: Request) {
  const auth = await authorize("budgets.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const today = dateKeyInTimeZone(new Date(), settings.timeZone);
    const year = parseYear(new URL(request.url).searchParams.get("year"), Number(today.slice(0, 4)));
    if (!year) return fail("Choose a valid budget year.", 422);
    const selectedId = new URL(request.url).searchParams.get("id");
    if (selectedId && !ObjectId.isValid(selectedId)) return fail("The budget revision reference is invalid.", 422);

    const [chartAccounts, plans, actualDocuments] = await Promise.all([
      db.collection("chartOfAccounts").find({ type: { $in: ["REVENUE", "EXPENSE"] } }).project({ code: 1, name: 1, type: 1, active: 1 }).sort({ type: 1, code: 1 }).toArray(),
      db.collection("budgetPlans").find({ year }).sort({ revision: -1 }).toArray(),
      db.collection("journalEntries").aggregate([
        { $match: { status: "POSTED", date: { $gte: new Date(`${year - 1}-12-29T00:00:00.000Z`), $lt: new Date(`${year + 1}-01-03T00:00:00.000Z`) } } },
        { $addFields: { _budgetDate: journalReportDateExpression(settings.timeZone) } },
        { $match: { _budgetDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } } },
        { $unwind: "$lines" },
        { $group: { _id: { accountCode: "$lines.accountCode", month: { $substrBytes: ["$_budgetDate", 5, 2] } }, debit: { $sum: { $ifNull: ["$lines.debit", 0] } }, credit: { $sum: { $ifNull: ["$lines.credit", 0] } } } },
      ]).toArray(),
    ]);
    const selected = selectedId ? plans.find(plan => String(plan._id) === selectedId) : plans.find(plan => plan.status === "DRAFT") || plans.find(plan => plan.status === "APPROVED") || plans[0];
    const selectedLines = new Map<string, BudgetLine>((Array.isArray(selected?.lines) ? selected.lines : []).map((line: BudgetLine) => [String(line.accountCode), line]));
    const chartMap = new Map(chartAccounts.map(account => [String(account.code), account]));
    for (const line of selectedLines.values()) if (!chartMap.has(line.accountCode)) chartMap.set(line.accountCode, { code: line.accountCode, name: line.accountName, type: line.accountType, active: false } as never);
    const actualMap = new Map(actualDocuments.map(item => [`${String(item._id.accountCode)}:${String(item._id.month)}`, item]));
    const ytdMonths = budgetYtdMonths(year, today);
    const rows = [...chartMap.values()].filter(account => ["REVENUE", "EXPENSE"].includes(String(account.type))).sort((left, right) => String(left.type).localeCompare(String(right.type)) || String(left.code).localeCompare(String(right.code), "en", { numeric: true })).map(account => {
      const code = String(account.code), type = String(account.type) as BudgetAccountType;
      const monthlyBudget = selectedLines.get(code)?.monthly?.map(Number) || Array(12).fill(0);
      const monthlyActual = Array.from({ length: 12 }, (_, index) => {
        const movement = actualMap.get(`${code}:${String(index + 1).padStart(2, "0")}`);
        return budgetActual(type, movement?.debit, movement?.credit, settings.currency);
      });
      const ytdBudget = roundCurrency(monthlyBudget.slice(0, ytdMonths).reduce((sum, value) => sum + value, 0), settings.currency);
      const ytdActual = roundCurrency(monthlyActual.slice(0, ytdMonths).reduce((sum, value) => sum + value, 0), settings.currency);
      const yearBudget = roundCurrency(monthlyBudget.reduce((sum, value) => sum + value, 0), settings.currency);
      const yearActual = roundCurrency(monthlyActual.reduce((sum, value) => sum + value, 0), settings.currency);
      return { code, name: String(account.name), type, active: account.active !== false, monthlyBudget, monthlyActual, ytd: budgetVariance(type, ytdBudget, ytdActual, settings.currency), year: budgetVariance(type, yearBudget, yearActual, settings.currency) };
    });
    const total = (type: BudgetAccountType, field: "budget" | "actual") => roundCurrency(rows.filter(row => row.type === type).reduce((sum, row) => sum + row.ytd[field], 0), settings.currency);
    const revenueBudget = total("REVENUE", "budget"), revenueActual = total("REVENUE", "actual"), expenseBudget = total("EXPENSE", "budget"), expenseActual = total("EXPENSE", "actual");
    return ok(serialise({
      year, today, ytdMonths, currency: settings.currency,
      permissions: { write: hasPermission(auth.session.role, "budgets.write"), approve: canApproveBudget(auth.session.role) },
      plans: plans.map(plan => ({ _id: plan._id, year: plan.year, revision: plan.revision, name: plan.name, status: plan.status, version: plan.version, updatedAt: plan.updatedAt, approvedAt: plan.approvedAt, approvedByName: plan.approvedByName })),
      selected: safeBudgetPlan(selected), rows,
      summary: { revenueBudget, revenueActual, expenseBudget, expenseActual, profitBudget: roundCurrency(revenueBudget - expenseBudget, settings.currency), profitActual: roundCurrency(revenueActual - expenseActual, settings.currency), profitVariance: roundCurrency((revenueActual - expenseActual) - (revenueBudget - expenseBudget), settings.currency) },
    }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("budgets.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return fail("The request body must be valid JSON.", 400); }
    const parsed = budgetCreateSchema.safeParse(body);
    if (!parsed.success) return fail("Choose a valid budget year.", 422, parsed.error.flatten().fieldErrors);
    const db = await getDb();
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const currentYear = Number(dateKeyInTimeZone(new Date(), settings.timeZone).slice(0, 4));
    if (parsed.data.year < currentYear - 5 || parsed.data.year > currentYear + 10) return fail("Choose a budget year within five years back or ten years ahead.", 422);
    const client = await getMongoClient(), session = client.startSession(), now = new Date();
    let plan: Record<string, any> | null = null, existing = false;
    try {
      await session.withTransaction(async () => {
        await touchBusinessKeyLock(db, businessKeyLockId("BUDGET_YEAR", parsed.data.year), session, now);
        const existingDraft = await db.collection("budgetPlans").findOne({ year: parsed.data.year, status: "DRAFT" }, { session });
        if (existingDraft) { plan = existingDraft; existing = true; return; }
        const [latest, approved, accounts] = await Promise.all([
          db.collection("budgetPlans").find({ year: parsed.data.year }, { session }).sort({ revision: -1 }).limit(1).next(),
          db.collection("budgetPlans").findOne({ year: parsed.data.year, status: "APPROVED" }, { session }),
          db.collection("chartOfAccounts").find({ type: { $in: ["REVENUE", "EXPENSE"] }, active: { $ne: false } }, { session }).project({ code: 1, name: 1, type: 1 }).sort({ type: 1, code: 1 }).toArray(),
        ]);
        const approvedMap = new Map<string, BudgetLine>((Array.isArray(approved?.lines) ? approved.lines : []).map((line: BudgetLine) => [String(line.accountCode), line]));
        const lines = accounts.map(account => ({ accountCode: String(account.code), accountName: String(account.name), accountType: String(account.type), monthly: approvedMap.get(String(account.code))?.monthly?.map(Number) || Array(12).fill(0) }));
        const revision = Number(latest?.revision || 0) + 1, _id = new ObjectId();
        plan = { _id, year: parsed.data.year, revision, name: `${parsed.data.year} operating budget`, notes: approved ? `Revision ${revision} copied from approved revision ${approved.revision}.` : "", currency: settings.currency, timeZone: settings.timeZone, status: "DRAFT", activeSlot: "DRAFT", version: 1, lines, createdBy: new ObjectId(auth.session.id), createdByName: auth.session.fullName, createdAt: now, updatedAt: now, history: [{ action: "CREATED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }] };
        await db.collection("budgetPlans").insertOne(plan, { session });
        await writeAudit(db, auth.session, "budget.create", "budgetPlan", _id.toHexString(), { year: parsed.data.year, revision }, session);
      });
    } finally { await session.endSession(); }
    return existing ? ok(serialise(safeBudgetPlan(plan))) : created(serialise(safeBudgetPlan(plan)));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("A draft already exists for this budget year. Reload the page.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("budgets.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let parsed: ReturnType<typeof budgetActionSchema.safeParse>;
  try { parsed = budgetActionSchema.safeParse(await request.json()); } catch { return fail("The request body must be valid JSON.", 400); }
  if (!parsed.success || !ObjectId.isValid(parsed.data?.id || "")) return fail("Check the budget action.", 422, parsed.success ? undefined : parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  try {
    const db = await getDb(), id = new ObjectId(input.id), now = new Date();
    if (input.action === "SAVE") {
      const plan = await db.collection("budgetPlans").findOne({ _id: id, status: "DRAFT", version: input.expectedVersion });
      if (!plan) return fail("The draft changed or is no longer editable. Reload and try again.", 409);
      const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
      const codes = input.lines.map(line => line.accountCode);
      const accounts = await db.collection("chartOfAccounts").find({ code: { $in: codes }, type: { $in: ["REVENUE", "EXPENSE"] } }).project({ code: 1, name: 1, type: 1 }).toArray();
      const accountMap = new Map(accounts.map(account => [String(account.code), account]));
      if (accountMap.size !== new Set(codes).size) return fail("One or more budget accounts are unavailable.", 422);
      let lines: BudgetLine[];
      try { lines = input.lines.map(line => { const account = accountMap.get(line.accountCode)!; return { accountCode: line.accountCode, accountName: String(account.name), accountType: String(account.type) as BudgetAccountType, monthly: validateBudgetPrecision(line.monthly, settings.currency) }; }); }
      catch (error) { return fail(error instanceof Error ? error.message : "Check the budget amounts.", 422); }
      const updated = await db.collection("budgetPlans").findOneAndUpdate(
        { _id: id, status: "DRAFT", version: input.expectedVersion },
        { $set: { name: input.name, notes: input.notes, lines, currency: settings.currency, timeZone: settings.timeZone, updatedAt: now, updatedBy: new ObjectId(auth.session.id), updatedByName: auth.session.fullName, history: [...(Array.isArray(plan.history) ? plan.history : []), { action: "SAVED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }] }, $inc: { version: 1 } },
        { returnDocument: "after" },
      );
      if (!updated) return fail("Another user changed this budget. Reload and try again.", 409);
      await writeAudit(db, auth.session, "budget.save", "budgetPlan", input.id, { year: plan.year, revision: plan.revision, version: updated.version });
      return ok(serialise(safeBudgetPlan(updated)));
    }
    const approval = input;
    if (!canApproveBudget(auth.session.role)) return fail("Only the Owner can approve and lock a budget revision.", 403);
    const client = await getMongoClient();
    const session = client.startSession();
    let result: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(async () => {
        const plan = await db.collection("budgetPlans").findOne({ _id: id, status: "DRAFT", version: approval.expectedVersion }, { session });
        if (!plan) throw new BudgetConflictError("The budget draft changed or is no longer awaiting approval.");
        await touchBusinessKeyLock(db, businessKeyLockId("BUDGET_YEAR", Number(plan.year)), session, now);
        const hasBudget = Array.isArray(plan.lines) && plan.lines.some((line: BudgetLine) => line.monthly.some(value => Number(value) > 0));
        if (!hasBudget) throw new BudgetConflictError("Enter at least one budget amount before approval.");
        const prior = await db.collection("budgetPlans").findOne({ year: plan.year, status: "APPROVED", _id: { $ne: id } }, { session });
        if (prior) await db.collection("budgetPlans").updateOne({ _id: prior._id, status: "APPROVED" }, { $set: { status: "SUPERSEDED", supersededAt: now, supersededBy: new ObjectId(auth.session.id), updatedAt: now, history: [...(Array.isArray(prior.history) ? prior.history : []), { action: "SUPERSEDED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, note: approval.note, at: now }] }, $unset: { activeSlot: "" } }, { session });
        const approved = await db.collection("budgetPlans").findOneAndUpdate({ _id: id, status: "DRAFT", version: approval.expectedVersion }, { $set: { status: "APPROVED", activeSlot: "APPROVED", approvedAt: now, approvedBy: new ObjectId(auth.session.id), approvedByName: auth.session.fullName, approvalNote: approval.note, updatedAt: now, history: [...(Array.isArray(plan.history) ? plan.history : []), { action: "APPROVED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, note: approval.note, at: now }] }, $inc: { version: 1 } }, { returnDocument: "after", session });
        if (!approved) throw new BudgetConflictError("The budget changed while approval was being recorded.");
        await writeAudit(db, auth.session, "budget.approve", "budgetPlan", approval.id, { year: plan.year, revision: plan.revision, note: approval.note }, session);
        result = approved;
      });
    } finally { await session.endSession(); }
    return ok(serialise(safeBudgetPlan(result)));
  } catch (error) {
    if (error instanceof BudgetConflictError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("Another approved or draft budget already exists for this year.", 409);
    return publicError(error);
  }
}
