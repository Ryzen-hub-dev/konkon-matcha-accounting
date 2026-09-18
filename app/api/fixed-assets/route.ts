import { ObjectId, type ClientSession, type Db } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { AccountingPeriodClosedError, accountingPeriodBounds, periodKeyFromDateKey } from "@/lib/accounting-periods";
import { assertAccountingPeriodOpen } from "@/lib/accounting-period-lock";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { ensureFixedAssetAccounts, FIXED_ASSET_ACCOUNTS } from "@/lib/fixed-asset-accounts";
import {
  assertFixedAssetVersion, depreciationPostingAmount, fixedAssetActionSchema, fixedAssetDepreciationDue,
  fixedAssetDisposalAmounts, FixedAssetError, fixedAssetInputSchema, nextFixedAssetDepreciationPeriod,
  nextFixedAssetUpdatedAt,
} from "@/lib/fixed-assets";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";
import { prepareJournalAmounts, type JournalAmountLine } from "@/lib/journals";

export const runtime = "nodejs";

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

type LedgerAccount = Record<string, unknown>;

function accountByCode(accounts: LedgerAccount[], code: string) {
  return accounts.find(account => String(account.code) === code);
}

function requireAccount(accounts: LedgerAccount[], code: string, type: string, label: string, cashRule: "ANY" | "REQUIRED" | "FORBIDDEN" = "ANY") {
  const account = accountByCode(accounts, code);
  if (!account || account.active === false || String(account.type) !== type
    || (cashRule === "REQUIRED" && account.cashEquivalent !== true)
    || (cashRule === "FORBIDDEN" && account.cashEquivalent === true)) {
    throw new FixedAssetError(`Choose an active ${label} account.`, 422);
  }
  return { code: String(account.code), name: String(account.name) };
}

function journalDocument(input: {
  businessDate: string; currency: string; timeZone: string; memo: string; reference: string;
  source: string; sourceId: ObjectId; createdBy: ObjectId; lines: JournalAmountLine[];
}) {
  const amounts = prepareJournalAmounts(input.lines, input.currency);
  return {
    _id: new ObjectId(), entryNo: makeDocumentNo("JE"), date: new Date(`${input.businessDate}T00:00:00.000Z`),
    businessDate: input.businessDate, currency: input.currency, timeZone: input.timeZone,
    memo: input.memo, reference: input.reference, source: input.source, sourceId: input.sourceId,
    status: "POSTED", ...amounts, createdBy: input.createdBy, createdAt: new Date(),
  };
}

export async function GET(request: Request) {
  const auth = await authorize("accounting.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = new URL(request.url).searchParams.get("id") || "";
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The asset reference is invalid.", 422);
      const _id = new ObjectId(id);
      const [asset, depreciation] = await Promise.all([
        db.collection("fixedAssets").findOne({ _id }),
        db.collection("fixedAssetDepreciation").find({ assetId: _id }).sort({ periodKey: -1 }).limit(600).toArray(),
      ]);
      return asset ? ok(serialise({ asset, depreciation })) : fail("This asset could not be found.", 404);
    }
    const [businessRecord, assets, savedAccounts, runs] = await Promise.all([
      db.collection("settings").findOne({ key: "business" }),
      db.collection("fixedAssets").find({}).sort({ status: 1, assetNo: 1 }).limit(1_000).toArray(),
      db.collection("chartOfAccounts").find({ type: { $in: ["ASSET", "EXPENSE", "REVENUE"] } }).project({ code: 1, name: 1, type: 1, cashEquivalent: 1, active: 1 }).sort({ code: 1 }).toArray(),
      db.collection("fixedAssetDepreciationRuns").find({}).sort({ periodKey: -1, createdAt: -1 }).limit(24).toArray(),
    ]);
    const business = normaliseBusinessSettings(businessRecord);
    const today = dateKeyInTimeZone(new Date(), business.timeZone);
    const accounts = savedAccounts.filter(account => account.active !== false);
    for (const account of FIXED_ASSET_ACCOUNTS) {
      if (!savedAccounts.some(saved => String(saved.code) === account.code)) accounts.push({ ...account, active: true } as never);
    }
    accounts.sort((left, right) => String(left.code).localeCompare(String(right.code)));
    return ok(serialise({ assets, accounts, runs, currency: business.currency, timeZone: business.timeZone, today, currentPeriodKey: today.slice(0, 7) }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const parsed = fixedAssetInputSchema.safeParse(body.value);
  if (!parsed.success) return fail("Check the asset details.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const result = await session.withTransaction(async () => {
        const existing = await db.collection("fixedAssets").findOne({ clientRequestId: input.clientRequestId }, { session });
        if (existing) return { asset: existing, isNew: false };
        const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session }));
        const today = dateKeyInTimeZone(new Date(), business.timeZone);
        const currentPeriodKey = today.slice(0, 7);
        if (input.purchaseDate > today) throw new FixedAssetError("The purchase date cannot be in the future.", 422);
        if (input.openingThroughPeriod && input.openingThroughPeriod >= currentPeriodKey) throw new FixedAssetError("Opening depreciation coverage must end before the current accounting month.", 422);
        const latestClosed = await db.collection("accountingPeriods").findOne({ status: "CLOSED" }, { projection: { periodKey: 1 }, sort: { periodKey: -1 }, session });
        if (input.acquisitionMode === "REGISTER_ONLY" && latestClosed && periodKeyFromDateKey(input.inServiceDate) <= String(latestClosed.periodKey)
          && (!input.openingThroughPeriod || input.openingThroughPeriod < String(latestClosed.periodKey))) {
          throw new FixedAssetError(`This migrated asset must mark depreciation as covered through the latest closed month, ${String(latestClosed.periodKey)}.`, 422);
        }
        await ensureFixedAssetAccounts(db, new ObjectId(auth.session.id), session);
        const accountCodes = [input.assetAccountCode, input.accumulatedDepreciationAccountCode, input.depreciationExpenseAccountCode, input.gainAccountCode, input.lossAccountCode, input.paymentAccountCode].filter(Boolean);
        const accounts = await db.collection("chartOfAccounts").find({ code: { $in: accountCodes } }, { session }).toArray();
        const assetAccount = requireAccount(accounts, input.assetAccountCode, "ASSET", "fixed asset", "FORBIDDEN");
        const accumulatedAccount = requireAccount(accounts, input.accumulatedDepreciationAccountCode, "ASSET", "accumulated depreciation", "FORBIDDEN");
        const depreciationAccount = requireAccount(accounts, input.depreciationExpenseAccountCode, "EXPENSE", "depreciation expense");
        const gainAccount = requireAccount(accounts, input.gainAccountCode, "REVENUE", "asset disposal gain");
        const lossAccount = requireAccount(accounts, input.lossAccountCode, "EXPENSE", "asset disposal loss");
        const paymentAccount = input.acquisitionMode === "CASH_PURCHASE" ? requireAccount(accounts, input.paymentAccountCode, "ASSET", "cash or bank", "REQUIRED") : null;
        const cost = roundCurrency(input.cost, business.currency);
        const residualValue = roundCurrency(input.residualValue, business.currency);
        const openingAccumulatedDepreciation = roundCurrency(input.openingAccumulatedDepreciation, business.currency);
        if (currencyMinorUnits(cost, business.currency) !== currencyMinorUnits(input.cost, business.currency)
          || Math.abs(cost - input.cost) > 1e-8 || Math.abs(residualValue - input.residualValue) > 1e-8
          || Math.abs(openingAccumulatedDepreciation - input.openingAccumulatedDepreciation) > 1e-8) {
          throw new FixedAssetError(`Use the supported decimal precision for ${business.currency}.`, 422);
        }
        const depreciableAmount = roundCurrency(cost - residualValue, business.currency);
        const now = new Date();
        const _id = new ObjectId();
        const assetNo = makeDocumentNo("FA");
        const fullyDepreciated = currencyMinorUnits(openingAccumulatedDepreciation, business.currency) >= currencyMinorUnits(depreciableAmount, business.currency);
        const asset = {
          _id, assetNo, clientRequestId: input.clientRequestId, acquisitionMode: input.acquisitionMode,
          name: input.name, category: input.category, serialNo: input.serialNo, location: input.location, custodian: input.custodian,
          purchaseDate: new Date(`${input.purchaseDate}T00:00:00.000Z`), purchaseDateKey: input.purchaseDate,
          inServiceDate: new Date(`${input.inServiceDate}T00:00:00.000Z`), inServiceDateKey: input.inServiceDate,
          cost, residualValue, depreciableAmount, usefulLifeMonths: input.usefulLifeMonths,
          accumulatedDepreciation: openingAccumulatedDepreciation,
          netBookValue: roundCurrency(cost - openingAccumulatedDepreciation, business.currency),
          ...(input.openingThroughPeriod ? { openingThroughPeriod: input.openingThroughPeriod, lastDepreciationPeriod: input.openingThroughPeriod } : {}),
          assetAccountCode: assetAccount.code, assetAccountName: assetAccount.name,
          accumulatedDepreciationAccountCode: accumulatedAccount.code, accumulatedDepreciationAccountName: accumulatedAccount.name,
          depreciationExpenseAccountCode: depreciationAccount.code, depreciationExpenseAccountName: depreciationAccount.name,
          gainAccountCode: gainAccount.code, gainAccountName: gainAccount.name,
          lossAccountCode: lossAccount.code, lossAccountName: lossAccount.name,
          ...(paymentAccount ? { paymentAccountCode: paymentAccount.code, paymentAccountName: paymentAccount.name } : {}),
          supplierReference: input.supplierReference, notes: input.notes, currency: business.currency, timeZone: business.timeZone,
          status: fullyDepreciated ? "FULLY_DEPRECIATED" : "ACTIVE", depreciationMethod: "STRAIGHT_LINE_FULL_MONTH",
          createdBy: new ObjectId(auth.session.id), createdByName: auth.session.fullName, createdAt: now, updatedAt: now,
        };
        const guardedPeriods = new Set<string>();
        if (input.acquisitionMode === "CASH_PURCHASE") guardedPeriods.add(periodKeyFromDateKey(input.purchaseDate));
        const firstDepreciationPeriod = nextFixedAssetDepreciationPeriod(asset);
        if (!fullyDepreciated && firstDepreciationPeriod <= currentPeriodKey) guardedPeriods.add(firstDepreciationPeriod);
        for (const periodKey of guardedPeriods) await assertAccountingPeriodOpen(db, `${periodKey}-01`, session);
        let acquisitionJournal: ReturnType<typeof journalDocument> | null = null;
        if (input.acquisitionMode === "CASH_PURCHASE") {
          acquisitionJournal = journalDocument({
            businessDate: input.purchaseDate, currency: business.currency, timeZone: business.timeZone,
            memo: `Fixed asset purchase · ${assetNo} · ${input.name}`, reference: input.supplierReference || assetNo,
            source: "FIXED_ASSET_ACQUISITION", sourceId: _id, createdBy: new ObjectId(auth.session.id),
            lines: [
              { accountCode: assetAccount.code, accountName: assetAccount.name, debit: cost, credit: 0 },
              { accountCode: paymentAccount!.code, accountName: paymentAccount!.name, debit: 0, credit: cost },
            ],
          });
          await db.collection("journalEntries").insertOne(acquisitionJournal, { session });
          Object.assign(asset, { acquisitionJournalEntryId: acquisitionJournal._id, acquisitionEntryNo: acquisitionJournal.entryNo });
        }
        await db.collection("fixedAssets").insertOne(asset, { session });
        await writeAudit(db, auth.session, "fixed_asset.create", "fixedAsset", _id.toHexString(), {
          assetNo, acquisitionMode: input.acquisitionMode, cost, currency: business.currency,
          acquisitionEntryNo: acquisitionJournal?.entryNo || null, openingAccumulatedDepreciation,
        }, session);
        return { asset, isNew: true };
      });
      return result.isNew ? created(serialise(result.asset)) : ok(serialise(result.asset));
    } finally { await session.endSession(); }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existing = await (await getDb()).collection("fixedAssets").findOne({ clientRequestId: input.clientRequestId });
      if (existing) return ok(serialise(existing));
    }
    if (error instanceof FixedAssetError || error instanceof AccountingPeriodClosedError) return fail(error.message, error.status);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const parsed = fixedAssetActionSchema.safeParse(body.value);
  if (!parsed.success) return fail("Check the asset action.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      if (input.action === "RUN_DEPRECIATION") {
        const result = await session.withTransaction(async () => runDepreciation(db, session, auth.session, input));
        return result.isNew ? created(serialise(result.run)) : ok(serialise(result.run));
      }
      const result = await session.withTransaction(async () => disposeAsset(db, session, auth.session, input));
      return result.isNew ? created(serialise(result.disposal)) : ok(serialise(result.disposal));
    } finally { await session.endSession(); }
  } catch (error) {
    if (error instanceof FixedAssetError || error instanceof AccountingPeriodClosedError) return fail(error.message, error.status);
    if ((error as { code?: number }).code === 11000) {
      const collection = input.action === "RUN_DEPRECIATION" ? "fixedAssetDepreciationRuns" : "fixedAssetDisposals";
      const existing = await (await getDb()).collection(collection).findOne({ clientRequestId: input.clientRequestId });
      if (existing) return ok(serialise(existing));
    }
    return publicError(error);
  }
}

type SessionUser = { id: string; username: string; fullName: string; role: string };

async function runDepreciation(db: Db, session: ClientSession, user: SessionUser, input: Extract<z.infer<typeof fixedAssetActionSchema>, { action: "RUN_DEPRECIATION" }>) {
  const existing = await db.collection("fixedAssetDepreciationRuns").findOne({ clientRequestId: input.clientRequestId }, { session });
  if (existing) return { run: existing, isNew: false };
  const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session }));
  const today = dateKeyInTimeZone(new Date(), business.timeZone);
  if (input.periodKey > today.slice(0, 7)) throw new FixedAssetError("Future-month depreciation cannot be posted.", 422);
  const assets = await db.collection("fixedAssets").find({ status: "ACTIVE" }, { session }).sort({ assetNo: 1 }).limit(1_001).toArray();
  if (assets.length > 1_000) throw new FixedAssetError("This run exceeds 1,000 assets. Split the register before posting.", 422);
  const due = assets.filter(asset => fixedAssetDepreciationDue(asset as never, input.periodKey, business.currency));
  const overdue = due.find(asset => nextFixedAssetDepreciationPeriod(asset as never) < input.periodKey);
  if (overdue) throw new FixedAssetError(`${String(overdue.assetNo)} · ${String(overdue.name)} must post ${nextFixedAssetDepreciationPeriod(overdue as never)} before ${input.periodKey}.`, 422);
  const candidates = due.filter(asset => nextFixedAssetDepreciationPeriod(asset as never) === input.periodKey);
  if (!candidates.length) throw new FixedAssetError(`No active assets have depreciation due for ${input.periodKey}.`, 422);
  const postingDate = input.periodKey === today.slice(0, 7) ? today : accountingPeriodBounds(input.periodKey).endKey;
  await assertAccountingPeriodOpen(db, postingDate, session);
  const codes = [...new Set(candidates.flatMap(asset => [String(asset.depreciationExpenseAccountCode), String(asset.accumulatedDepreciationAccountCode)]))];
  const accounts = await db.collection("chartOfAccounts").find({ code: { $in: codes }, active: { $ne: false } }, { session }).toArray();
  const grouped = new Map<string, { accountCode: string; accountName: string; debit: number; credit: number }>();
  const postings = candidates.map(asset => {
    const expense = requireAccount(accounts, String(asset.depreciationExpenseAccountCode), "EXPENSE", "depreciation expense");
    const accumulated = requireAccount(accounts, String(asset.accumulatedDepreciationAccountCode), "ASSET", "accumulated depreciation", "FORBIDDEN");
    const amount = depreciationPostingAmount(asset as never, input.periodKey, business.currency);
    if (!currencyMinorUnits(amount, business.currency)) throw new FixedAssetError(`${String(asset.assetNo)} has no depreciable balance remaining. Refresh the register.`, 409);
    addGrouped(grouped, expense, amount, 0, business.currency);
    addGrouped(grouped, accumulated, 0, amount, business.currency);
    return { asset, amount };
  });
  const runId = new ObjectId();
  const runNo = makeDocumentNo("DEP");
  const journal = journalDocument({
    businessDate: postingDate, currency: business.currency, timeZone: business.timeZone,
    memo: `Fixed asset depreciation · ${input.periodKey} · ${postings.length} asset${postings.length === 1 ? "" : "s"}`,
    reference: runNo, source: "FIXED_ASSET_DEPRECIATION", sourceId: runId, createdBy: new ObjectId(user.id), lines: [...grouped.values()],
  });
  const now = new Date();
  for (const posting of postings) {
    const asset = posting.asset;
    const accumulatedDepreciation = roundCurrency(Number(asset.accumulatedDepreciation || 0) + posting.amount, business.currency);
    const netBookValue = roundCurrency(Number(asset.cost) - accumulatedDepreciation, business.currency);
    const fullyDepreciated = currencyMinorUnits(netBookValue, business.currency) <= currencyMinorUnits(asset.residualValue, business.currency);
    const updatedAt = nextFixedAssetUpdatedAt(asset.updatedAt, now);
    const updated = await db.collection("fixedAssets").updateOne(
      { _id: asset._id, status: "ACTIVE", updatedAt: asset.updatedAt },
      { $set: { accumulatedDepreciation, netBookValue, lastDepreciationPeriod: input.periodKey, lastDepreciationAt: now, status: fullyDepreciated ? "FULLY_DEPRECIATED" : "ACTIVE", updatedAt } },
      { session },
    );
    if (updated.modifiedCount !== 1) throw new FixedAssetError(`${String(asset.assetNo)} changed. Refresh before posting depreciation.`);
    await db.collection("fixedAssetDepreciation").insertOne({
      _id: new ObjectId(), assetId: asset._id, assetNo: asset.assetNo, assetName: asset.name, periodKey: input.periodKey,
      amount: posting.amount, priorAccumulatedDepreciation: Number(asset.accumulatedDepreciation || 0), accumulatedDepreciation,
      netBookValue, expenseAccountCode: asset.depreciationExpenseAccountCode,
      accumulatedDepreciationAccountCode: asset.accumulatedDepreciationAccountCode,
      runId, runNo, journalEntryId: journal._id, entryNo: journal.entryNo, postedBy: new ObjectId(user.id), postedAt: now,
    }, { session });
  }
  const total = roundCurrency(postings.reduce((sum, posting) => sum + posting.amount, 0), business.currency);
  const run = {
    _id: runId, runNo, clientRequestId: input.clientRequestId, periodKey: input.periodKey, postingDate,
    assetCount: postings.length, total, currency: business.currency, note: input.note,
    journalEntryId: journal._id, entryNo: journal.entryNo, createdBy: new ObjectId(user.id), createdByName: user.fullName, createdAt: now,
  };
  await db.collection("journalEntries").insertOne(journal, { session });
  await db.collection("fixedAssetDepreciationRuns").insertOne(run, { session });
  await writeAudit(db, user, "fixed_asset.depreciation_post", "fixedAssetDepreciationRun", runId.toHexString(), { runNo, periodKey: input.periodKey, assetCount: postings.length, total, entryNo: journal.entryNo, note: input.note }, session);
  return { run, isNew: true };
}

async function disposeAsset(db: Db, session: ClientSession, user: SessionUser, input: Extract<z.infer<typeof fixedAssetActionSchema>, { action: "DISPOSE" }>) {
  const existing = await db.collection("fixedAssetDisposals").findOne({ clientRequestId: input.clientRequestId }, { session });
  if (existing) return { disposal: existing, isNew: false };
  const _id = new ObjectId(input.id);
  const [asset, businessRecord] = await Promise.all([
    db.collection("fixedAssets").findOne({ _id }, { session }),
    db.collection("settings").findOne({ key: "business" }, { session }),
  ]);
  if (!asset) throw new FixedAssetError("This asset could not be found.", 404);
  if (asset.status === "DISPOSED") throw new FixedAssetError("This asset is already disposed.");
  assertFixedAssetVersion(asset.updatedAt, input.expectedUpdatedAt);
  const business = normaliseBusinessSettings(businessRecord);
  const today = dateKeyInTimeZone(new Date(), business.timeZone);
  if (input.disposalDate > today) throw new FixedAssetError("The disposal date cannot be in the future.", 422);
  if (input.disposalDate < String(asset.inServiceDateKey || new Date(asset.inServiceDate).toISOString().slice(0, 10))) throw new FixedAssetError("The disposal date cannot be before the asset entered service.", 422);
  const disposalPeriod = periodKeyFromDateKey(input.disposalDate);
  if (fixedAssetDepreciationDue(asset as never, disposalPeriod, business.currency)) {
    throw new FixedAssetError(`Post depreciation for ${nextFixedAssetDepreciationPeriod(asset as never)} before disposing this asset.`, 422);
  }
  const proceeds = roundCurrency(input.proceeds, business.currency);
  if (Math.abs(proceeds - input.proceeds) > 1e-8) throw new FixedAssetError(`Use the supported decimal precision for ${business.currency}.`, 422);
  await assertAccountingPeriodOpen(db, input.disposalDate, session);
  const codes = [String(asset.assetAccountCode), String(asset.accumulatedDepreciationAccountCode), String(asset.gainAccountCode), String(asset.lossAccountCode), input.proceedsAccountCode].filter(Boolean);
  const accounts = await db.collection("chartOfAccounts").find({ code: { $in: codes } }, { session }).toArray();
  const assetAccount = requireAccount(accounts, String(asset.assetAccountCode), "ASSET", "fixed asset", "FORBIDDEN");
  const accumulatedAccount = requireAccount(accounts, String(asset.accumulatedDepreciationAccountCode), "ASSET", "accumulated depreciation", "FORBIDDEN");
  const gainAccount = requireAccount(accounts, String(asset.gainAccountCode), "REVENUE", "asset disposal gain");
  const lossAccount = requireAccount(accounts, String(asset.lossAccountCode), "EXPENSE", "asset disposal loss");
  const proceedsAccount = proceeds > 0 ? requireAccount(accounts, input.proceedsAccountCode, "ASSET", "cash or bank", "REQUIRED") : null;
  const amounts = fixedAssetDisposalAmounts(asset as never, proceeds, business.currency);
  const lines: JournalAmountLine[] = [
    ...(amounts.accumulatedDepreciation ? [{ accountCode: accumulatedAccount.code, accountName: accumulatedAccount.name, debit: amounts.accumulatedDepreciation, credit: 0 }] : []),
    ...(amounts.proceeds ? [{ accountCode: proceedsAccount!.code, accountName: proceedsAccount!.name, debit: amounts.proceeds, credit: 0 }] : []),
    ...(amounts.loss ? [{ accountCode: lossAccount.code, accountName: lossAccount.name, debit: amounts.loss, credit: 0 }] : []),
    { accountCode: assetAccount.code, accountName: assetAccount.name, debit: 0, credit: amounts.cost },
    ...(amounts.gain ? [{ accountCode: gainAccount.code, accountName: gainAccount.name, debit: 0, credit: amounts.gain }] : []),
  ];
  const disposalId = new ObjectId();
  const disposalNo = makeDocumentNo("FAD");
  const journal = journalDocument({
    businessDate: input.disposalDate, currency: business.currency, timeZone: business.timeZone,
    memo: `Fixed asset disposal · ${String(asset.assetNo)} · ${String(asset.name)}`,
    reference: input.reference || disposalNo, source: "FIXED_ASSET_DISPOSAL", sourceId: disposalId,
    createdBy: new ObjectId(user.id), lines,
  });
  const updatedAt = nextFixedAssetUpdatedAt(asset.updatedAt);
  const disposalSnapshot = {
    disposalId, disposalNo, disposalDate: input.disposalDate, disposalPeriod, ...amounts,
    proceedsAccountCode: proceedsAccount?.code || "", proceedsAccountName: proceedsAccount?.name || "",
    reference: input.reference, note: input.note, journalEntryId: journal._id, entryNo: journal.entryNo,
    disposedBy: new ObjectId(user.id), disposedByName: user.fullName, disposedAt: updatedAt,
  };
  const updated = await db.collection("fixedAssets").updateOne(
    { _id, status: { $ne: "DISPOSED" }, updatedAt: asset.updatedAt },
    { $set: { status: "DISPOSED", netBookValue: 0, disposalPeriod, disposalSnapshot, updatedAt } },
    { session },
  );
  if (updated.modifiedCount !== 1) throw new FixedAssetError("This asset changed. Refresh before disposing it.");
  const disposal = { _id: disposalId, assetId: _id, assetNo: asset.assetNo, assetName: asset.name, clientRequestId: input.clientRequestId, currency: business.currency, ...disposalSnapshot };
  await db.collection("journalEntries").insertOne(journal, { session });
  await db.collection("fixedAssetDisposals").insertOne(disposal, { session });
  await writeAudit(db, user, "fixed_asset.dispose", "fixedAsset", input.id, { assetNo: asset.assetNo, disposalNo, disposalDate: input.disposalDate, proceeds: amounts.proceeds, netBookValue: amounts.netBookValue, gain: amounts.gain, loss: amounts.loss, entryNo: journal.entryNo, note: input.note }, session);
  return { disposal, isNew: true };
}

function addGrouped(grouped: Map<string, JournalAmountLine>, account: { code: string; name: string }, debit: number, credit: number, currency: string) {
  const existing = grouped.get(account.code) || { accountCode: account.code, accountName: account.name, debit: 0, credit: 0 };
  existing.debit = roundCurrency(existing.debit + debit, currency);
  existing.credit = roundCurrency(existing.credit + credit, currency);
  grouped.set(account.code, existing);
}
