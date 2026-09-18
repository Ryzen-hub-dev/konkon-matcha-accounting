import { ObjectId, type ClientSession, type Db } from "mongodb";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import {
  accountingPeriodActionSchema, accountingPeriodBounds, AccountingPeriodError, accountingPeriodSnapshotChanged,
  assertAccountingPeriodVersion, assertCompletedAccountingPeriod, buildPeriodChecklist,
  nextAccountingPeriodUpdatedAt, shiftAccountingPeriod,
} from "@/lib/accounting-periods";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { serialise } from "@/lib/format";
import { fixedAssetDepreciationDue } from "@/lib/fixed-assets";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

async function checklistForPeriod(db: Db, periodKey: string, currency: string, timeZone: string, session?: ClientSession) {
  const bounds = accountingPeriodBounds(periodKey);
  const endDate = new Date(`${bounds.endKey}T00:00:00.000Z`);
  const coarseStart = new Date(bounds.start.getTime() - 86_400_000);
  const coarseEnd = new Date(bounds.end.getTime() + 86_400_000);
  const periodExpression = { $eq: [{ $dateToString: { format: "%Y-%m", date: "$date", timezone: timeZone } }, periodKey] };
  const options = session ? { session } : {};
  const bankAccounts = await db.collection("chartOfAccounts").find(
    { type: "ASSET", cashEquivalent: true, active: { $ne: false }, code: { $ne: "1000" } },
    { projection: { code: 1, name: 1 }, ...options },
  ).toArray();
  const bankCodes = bankAccounts.map(account => String(account.code));
  const [journalSummary, unbalancedCount, touchedBanks, fixedAssets] = await Promise.all([
    db.collection("journalEntries").aggregate([
      { $match: { status: "POSTED", date: { $gte: coarseStart, $lte: coarseEnd }, $expr: periodExpression } },
      { $group: { _id: null, journalCount: { $sum: 1 }, totalDebit: { $sum: "$totalDebit" }, totalCredit: { $sum: "$totalCredit" } } },
    ], options).toArray(),
    db.collection("journalEntries").countDocuments({ status: "POSTED", date: { $gte: coarseStart, $lte: coarseEnd }, $and: [{ $expr: periodExpression }, { $expr: { $ne: ["$totalDebit", "$totalCredit"] } }] }, options),
    bankCodes.length ? db.collection("journalEntries").aggregate([
      { $match: { status: "POSTED", date: { $gte: coarseStart, $lte: coarseEnd }, $expr: periodExpression, "lines.accountCode": { $in: bankCodes } } },
      { $unwind: "$lines" },
      { $match: { "lines.accountCode": { $in: bankCodes } } },
      { $group: { _id: "$lines.accountCode" } },
    ], options).toArray() : [],
    db.collection("fixedAssets").find(
      { status: { $in: ["ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"] } },
      { projection: { cost: 1, residualValue: 1, usefulLifeMonths: 1, accumulatedDepreciation: 1, inServiceDate: 1, lastDepreciationPeriod: 1, openingThroughPeriod: 1, status: 1, disposalPeriod: 1 }, ...options },
    ).toArray(),
  ]);
  const touched = new Set(touchedBanks.map(row => String(row._id)));
  const requiredBankAccounts = bankAccounts.filter(account => touched.has(String(account.code))).map(account => ({ code: String(account.code), name: String(account.name) }));
  const requiredCodes = requiredBankAccounts.map(account => account.code);
  const [completed, openCount] = requiredCodes.length ? await Promise.all([
    db.collection("bankReconciliations").find({
      accountCode: { $in: requiredCodes }, status: "COMPLETED",
      statementStartDate: { $lte: bounds.start }, statementDate: { $gte: endDate },
    }, { projection: { accountCode: 1 }, ...options }).toArray(),
    db.collection("bankReconciliations").countDocuments({
      accountCode: { $in: requiredCodes }, status: "DRAFT",
      statementStartDate: { $lte: endDate }, statementDate: { $gte: bounds.start },
    }, options),
  ]) : [[], 0];
  return buildPeriodChecklist({
    journalCount: Number(journalSummary[0]?.journalCount || 0),
    totalDebit: Number(journalSummary[0]?.totalDebit || 0),
    totalCredit: Number(journalSummary[0]?.totalCredit || 0),
    unbalancedCount,
    requiredBankAccounts,
    reconciledBankCodes: completed.map(item => String(item.accountCode)),
    openBankReconciliationCount: openCount,
    fixedAssetDueCount: fixedAssets.filter(asset => fixedAssetDepreciationDue(asset as never, periodKey, currency)).length,
  }, currency);
}

export async function GET() {
  const auth = await authorize("accounting.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const currentPeriodKey = dateKeyInTimeZone(new Date(), business.timeZone).slice(0, 7);
    const records = await db.collection("accountingPeriods").find({}).sort({ periodKey: -1 }).limit(60).toArray();
    const keys = new Set(records.map(record => String(record.periodKey)));
    for (let offset = 0; offset < 18; offset++) keys.add(shiftAccountingPeriod(currentPeriodKey, -offset));
    const periodKeys = [...keys].sort().reverse().slice(0, 60);
    const earliest = accountingPeriodBounds(periodKeys[periodKeys.length - 1]);
    const latest = accountingPeriodBounds(periodKeys[0]);
    const bankAccounts = await db.collection("chartOfAccounts").find(
      { type: "ASSET", cashEquivalent: true, active: { $ne: false }, code: { $ne: "1000" } },
      { projection: { code: 1, name: 1 } },
    ).toArray();
    const bankCodes = bankAccounts.map(account => String(account.code));
    const periodProjection = { $dateToString: { format: "%Y-%m", date: "$date", timezone: business.timeZone } };
    const [journalStats, bankMovements, reconciliations, fixedAssets] = await Promise.all([
      db.collection("journalEntries").aggregate([
        { $match: { status: "POSTED", date: { $gte: earliest.start, $lte: latest.end } } },
        { $project: { periodKey: periodProjection, totalDebit: { $ifNull: ["$totalDebit", 0] }, totalCredit: { $ifNull: ["$totalCredit", 0] } } },
        { $group: { _id: "$periodKey", journalCount: { $sum: 1 }, totalDebit: { $sum: "$totalDebit" }, totalCredit: { $sum: "$totalCredit" }, unbalancedCount: { $sum: { $cond: [{ $eq: ["$totalDebit", "$totalCredit"] }, 0, 1] } } } },
      ]).toArray(),
      bankCodes.length ? db.collection("journalEntries").aggregate([
        { $match: { status: "POSTED", date: { $gte: earliest.start, $lte: latest.end }, "lines.accountCode": { $in: bankCodes } } },
        { $project: { periodKey: periodProjection, lines: 1 } },
        { $unwind: "$lines" },
        { $match: { "lines.accountCode": { $in: bankCodes } } },
        { $group: { _id: { periodKey: "$periodKey", accountCode: "$lines.accountCode" } } },
      ]).toArray() : [],
      db.collection("bankReconciliations").find({
        status: { $in: ["DRAFT", "COMPLETED"] }, statementStartDate: { $lte: latest.end }, statementDate: { $gte: earliest.start },
      }, { projection: { accountCode: 1, status: 1, statementStartDate: 1, statementDate: 1 } }).toArray(),
      db.collection("fixedAssets").find(
        { status: { $in: ["ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"] } },
        { projection: { cost: 1, residualValue: 1, usefulLifeMonths: 1, accumulatedDepreciation: 1, inServiceDate: 1, lastDepreciationPeriod: 1, openingThroughPeriod: 1, status: 1, disposalPeriod: 1 } },
      ).toArray(),
    ]);
    const journalMap = new Map(journalStats.map(item => [String(item._id), item]));
    const touchedMap = new Map<string, Set<string>>();
    for (const movement of bankMovements) {
      const periodKey = String(movement._id?.periodKey || "");
      const accountCode = String(movement._id?.accountCode || "");
      if (!touchedMap.has(periodKey)) touchedMap.set(periodKey, new Set());
      touchedMap.get(periodKey)!.add(accountCode);
    }
    const recordMap = new Map(records.map(record => [String(record.periodKey), record]));
    const periods = periodKeys.map((periodKey, index) => {
      const record = recordMap.get(periodKey);
      const bounds = accountingPeriodBounds(periodKey);
      const touched = touchedMap.get(periodKey) || new Set<string>();
      const requiredBankAccounts = bankAccounts.filter(account => touched.has(String(account.code))).map(account => ({ code: String(account.code), name: String(account.name) }));
      const requiredCodes = new Set(requiredBankAccounts.map(account => account.code));
      const completedCodes = reconciliations.filter(item => item.status === "COMPLETED" && requiredCodes.has(String(item.accountCode))
        && new Date(item.statementStartDate) <= bounds.start && new Date(item.statementDate) >= new Date(`${bounds.endKey}T00:00:00.000Z`)).map(item => String(item.accountCode));
      const openCount = reconciliations.filter(item => item.status === "DRAFT" && requiredCodes.has(String(item.accountCode))
        && new Date(item.statementStartDate) <= new Date(`${bounds.endKey}T00:00:00.000Z`) && new Date(item.statementDate) >= bounds.start).length;
      const journal = journalMap.get(periodKey);
      const liveChecklist = buildPeriodChecklist({
        journalCount: Number(journal?.journalCount || 0), totalDebit: Number(journal?.totalDebit || 0), totalCredit: Number(journal?.totalCredit || 0),
        unbalancedCount: Number(journal?.unbalancedCount || 0), requiredBankAccounts,
        reconciledBankCodes: completedCodes, openBankReconciliationCount: openCount,
        fixedAssetDueCount: fixedAssets.filter(asset => fixedAssetDepreciationDue(asset as never, periodKey, business.currency)).length,
      }, business.currency);
      return {
        ...(record || {}), periodKey, status: record?.status === "CLOSED" ? "CLOSED" : "OPEN",
        isCurrent: periodKey === currentPeriodKey, canClose: periodKey < currentPeriodKey,
        checklist: record?.status === "CLOSED" && record.closeSnapshot ? record.closeSnapshot : liveChecklist,
        liveChecklist,
        integrityChanged: record?.status === "CLOSED" ? accountingPeriodSnapshotChanged(record.closeSnapshot, liveChecklist, business.currency) : false,
      };
    });
    return ok(serialise({ periods, currentPeriodKey, currency: business.currency, timeZone: business.timeZone }));
  } catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const parsed = accountingPeriodActionSchema.safeParse(body.value);
  if (!parsed.success) return fail("Check the period action.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  if (input.action === "REOPEN" && !hasPermission(auth.session.role, "owner.control")) return fail("Only the Owner can reopen a closed accounting period.", 403);
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const period = await session.withTransaction(async () => {
        const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session }));
        const currentPeriodKey = dateKeyInTimeZone(new Date(), business.timeZone).slice(0, 7);
        const current = await db.collection("accountingPeriods").findOne({ periodKey: input.periodKey }, { session });

        if (input.action === "CLOSE") {
          assertCompletedAccountingPeriod(input.periodKey, currentPeriodKey);
          if (current?.status === "CLOSED") return current;
          assertAccountingPeriodVersion(current?.updatedAt, input.expectedUpdatedAt);
          const checklist = await checklistForPeriod(db, input.periodKey, business.currency, business.timeZone, session);
          if (!checklist.ready) throw new AccountingPeriodError(`This month is not ready to close: ${checklist.blockers.join(" ")}`, 422);
          const bounds = accountingPeriodBounds(input.periodKey);
          const updatedAt = nextAccountingPeriodUpdatedAt(current?.updatedAt);
          const history = { _id: new ObjectId(), action: "CLOSE", note: input.note, actorId: new ObjectId(auth.session.id), actorName: auth.session.fullName, at: updatedAt };
          const filter = current ? { _id: current._id, status: { $ne: "CLOSED" }, updatedAt: current.updatedAt } : { periodKey: input.periodKey, status: { $ne: "CLOSED" } };
          const update: Record<string, unknown> = {
            $set: {
              periodKey: input.periodKey, periodStart: bounds.start, periodEnd: bounds.end, status: "CLOSED",
              closeSnapshot: checklist, closeNote: input.note, closedAt: updatedAt,
              closedBy: new ObjectId(auth.session.id), closedByName: auth.session.fullName, updatedAt,
            },
            $setOnInsert: { createdAt: updatedAt, postingVersion: 0 },
            $push: { history },
          };
          const updated = await db.collection("accountingPeriods").findOneAndUpdate(filter, update, { upsert: !current, returnDocument: "after", session });
          if (!updated) throw new AccountingPeriodError("This accounting period changed. Refresh before closing it.");
          await writeAudit(db, auth.session, "accounting_period.close", "accountingPeriod", input.periodKey, { periodKey: input.periodKey, note: input.note, journalCount: checklist.journalCount, totalDebit: checklist.totalDebit, bankAccounts: checklist.requiredBankAccountCount }, session);
          return updated;
        }

        if (!current || current.status !== "CLOSED") throw new AccountingPeriodError("This accounting period is already open.");
        assertAccountingPeriodVersion(current.updatedAt, input.expectedUpdatedAt);
        const laterClosed = await db.collection("accountingPeriods").findOne({ periodKey: { $gt: input.periodKey }, status: "CLOSED" }, { projection: { periodKey: 1 }, session });
        if (laterClosed) throw new AccountingPeriodError(`Reopen ${String(laterClosed.periodKey)} first. Closed periods must be reopened in reverse order.`);
        const updatedAt = nextAccountingPeriodUpdatedAt(current.updatedAt);
        const reopenUpdate: Record<string, unknown> = {
          $set: { status: "OPEN", lastCloseSnapshot: current.closeSnapshot, reopenNote: input.note, reopenedAt: updatedAt, reopenedBy: new ObjectId(auth.session.id), reopenedByName: auth.session.fullName, updatedAt },
          $unset: { closeSnapshot: "", closeNote: "", closedAt: "", closedBy: "", closedByName: "" },
          $push: { history: { _id: new ObjectId(), action: "REOPEN", note: input.note, actorId: new ObjectId(auth.session.id), actorName: auth.session.fullName, at: updatedAt } },
        };
        const updated = await db.collection("accountingPeriods").findOneAndUpdate(
          { _id: current._id, status: "CLOSED", updatedAt: current.updatedAt },
          reopenUpdate,
          { returnDocument: "after", session },
        );
        if (!updated) throw new AccountingPeriodError("This accounting period changed. Refresh before reopening it.");
        await writeAudit(db, auth.session, "accounting_period.reopen", "accountingPeriod", input.periodKey, { periodKey: input.periodKey, reason: input.note }, session);
        return updated;
      });
      return ok(serialise(period));
    } finally { await session.endSession(); }
  } catch (error) {
    if (error instanceof AccountingPeriodError) return fail(error.message, error.status);
    if ((error as { code?: number }).code === 11000) return fail("This accounting period changed. Refresh before trying again.", 409);
    return publicError(error);
  }
}
