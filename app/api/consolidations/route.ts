import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { consolidationInputSchema, consolidateGroup, ConsolidationError, type ConsolidationEntity } from "@/lib/consolidation";
import { journalReportDateExpression } from "@/lib/dates";
import { getDb } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { roundCurrency } from "@/lib/international";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_REQUEST_BYTES = 2_097_152;

function utcBoundary(value: string, dayOffset: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date;
}

export async function GET() {
  const auth = await authorize("reports.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [business, runs] = await Promise.all([
      db.collection("settings").findOne({ key: "business" }),
      db.collection("consolidationRuns").find({}).project({ inputEntities: 0, eliminations: 0 }).sort({ createdAt: -1 }).limit(30).toArray(),
    ]);
    const settings = normaliseBusinessSettings(business);
    return ok(serialise({
      business: { name: settings.legalEntityName || settings.businessName, currency: settings.currency, countryCode: settings.countryCode, suggestedCode: settings.franchiseCode || "PARENT" },
      runs,
      importSchema: "konkon.consolidation-entity.v1",
    }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let body: unknown;
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) return fail("The consolidation import is too large.", 413);
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) return fail("The consolidation import is too large.", 413);
    body = JSON.parse(rawBody);
  }
  catch { return fail("The request body must be valid JSON.", 400); }
  const parsed = consolidationInputSchema.safeParse(body);
  if (!parsed.success) return fail("Check the consolidation period, rates, imported entities and eliminations.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  try {
    const db = await getDb();
    const existing = await db.collection("consolidationRuns").findOne({ clientRequestId: input.clientRequestId });
    if (existing) return ok(serialise(existing));
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    // Archived masters can still carry historical posted balances and must remain in a group trial balance.
    const accounts = await db.collection("chartOfAccounts").find({}).project({ code: 1, name: 1, type: 1 }).toArray();
    const accountMap = new Map(accounts.map(account => [String(account.code), { name: String(account.name), type: String(account.type) }]));
    const upper = utcBoundary(input.periodTo, 2);
    const movements = await db.collection("journalEntries").aggregate([
      { $match: { status: "POSTED", date: { $lt: upper } } },
      { $addFields: { _reportDate: journalReportDateExpression(settings.timeZone) } },
      { $unwind: "$lines" },
      { $group: {
        _id: "$lines.accountCode",
        name: { $last: "$lines.accountName" },
        openingDebit: { $sum: { $cond: [{ $lt: ["$_reportDate", input.periodFrom] }, { $ifNull: ["$lines.debit", 0] }, 0] } },
        openingCredit: { $sum: { $cond: [{ $lt: ["$_reportDate", input.periodFrom] }, { $ifNull: ["$lines.credit", 0] }, 0] } },
        periodDebit: { $sum: { $cond: [{ $and: [{ $gte: ["$_reportDate", input.periodFrom] }, { $lte: ["$_reportDate", input.periodTo] }] }, { $ifNull: ["$lines.debit", 0] }, 0] } },
        periodCredit: { $sum: { $cond: [{ $and: [{ $gte: ["$_reportDate", input.periodFrom] }, { $lte: ["$_reportDate", input.periodTo] }] }, { $ifNull: ["$lines.credit", 0] }, 0] } },
      } },
    ]).toArray();
    let openingResult = 0;
    const rows: ConsolidationEntity["rows"] = [];
    for (const movement of movements) {
      const master = accountMap.get(String(movement._id));
      if (!master || !["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].includes(master.type)) continue;
      const profitAndLoss = ["REVENUE", "EXPENSE"].includes(master.type);
      if (profitAndLoss) openingResult += Number(movement.openingDebit || 0) - Number(movement.openingCredit || 0);
      const net = profitAndLoss
        ? Number(movement.periodDebit || 0) - Number(movement.periodCredit || 0)
        : Number(movement.openingDebit || 0) + Number(movement.periodDebit || 0) - Number(movement.openingCredit || 0) - Number(movement.periodCredit || 0);
      const rounded = roundCurrency(net, settings.currency);
      if (rounded) rows.push({ accountCode: String(movement._id), accountName: master.name || String(movement.name), accountType: master.type as ConsolidationEntity["rows"][number]["accountType"], debit: Math.max(rounded, 0), credit: Math.max(-rounded, 0) });
    }
    const retained = roundCurrency(openingResult, settings.currency);
    if (retained) rows.push({ accountCode: "3900", accountName: "Opening retained earnings", accountType: "EQUITY", debit: Math.max(retained, 0), credit: Math.max(-retained, 0) });
    if (!rows.length) return fail("The current entity has no posted journal balances for this period.", 409);
    const current: ConsolidationEntity = {
      entityCode: input.currentEntityCode, entityName: settings.legalEntityName || settings.businessName,
      countryCode: settings.countryCode, functionalCurrency: settings.currency,
      closingRate: input.currentEntityClosingRate, averageRate: input.currentEntityAverageRate, rows,
    };
    const result = consolidateGroup([current, ...input.importedEntities], input.eliminations, input.reportingCurrency);
    const now = new Date();
    const run = {
      _id: new ObjectId(), runNo: makeDocumentNo("CON"), clientRequestId: input.clientRequestId,
      periodFrom: input.periodFrom, periodTo: input.periodTo,
      currentEntityCode: input.currentEntityCode, reviewNote: input.reviewNote,
      inputEntities: [current, ...input.importedEntities], eliminations: input.eliminations,
      ...result, status: "PREPARED_REVIEW_REQUIRED", createdBy: new ObjectId(auth.session.id), createdByName: auth.session.fullName, createdAt: now,
    };
    await db.collection("consolidationRuns").insertOne(run);
    await writeAudit(db, auth.session, "consolidation.prepare", "consolidationRun", run._id.toHexString(), {
      runNo: run.runNo, periodFrom: run.periodFrom, periodTo: run.periodTo,
      reportingCurrency: run.reportingCurrency, entityCount: run.entities.length, eliminationCount: run.eliminationCount,
    });
    return created(serialise(run));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const db = await getDb();
      const existing = await db.collection("consolidationRuns").findOne({ clientRequestId: input.clientRequestId });
      if (existing) return ok(serialise(existing));
    }
    if (error instanceof ConsolidationError) return fail(error.message, error.status);
    return publicError(error);
  }
}
