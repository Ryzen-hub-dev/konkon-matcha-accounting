import { ClientSession, Db, ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import {
  assertBankMatch, assertBankReconciliationVersion, assertStatementArithmetic,
  bankReconciliationActionSchema, bankReconciliationInputSchema, bankReconciliationSummary,
  BankReconciliationError, nextBankReconciliationUpdatedAt, signedBankLine, statementMovement,
  suggestBankMatches,
} from "@/lib/bank-reconciliation";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";

export const runtime = "nodejs";

type LedgerLine = {
  key: string; journalEntryId: ObjectId; lineIndex: number; entryNo: string; businessDate: string;
  memo: string; reference: string; amount: number;
};

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

function dateKey(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function loadLedgerLines(db: Db, accountCode: string, throughDate: string, currency: string, session?: ClientSession) {
  const entries = await db.collection("journalEntries").find(
    { status: "POSTED", date: { $lte: new Date(`${throughDate}T23:59:59.999Z`) }, "lines.accountCode": accountCode },
    { projection: { entryNo: 1, date: 1, businessDate: 1, memo: 1, reference: 1, lines: 1 }, ...(session ? { session } : {}) },
  ).sort({ date: 1, createdAt: 1 }).limit(2001).toArray();
  const lines: LedgerLine[] = [];
  for (const entry of entries) {
    const entryLines = Array.isArray(entry.lines) ? entry.lines : [];
    entryLines.forEach((line: Record<string, unknown>, lineIndex: number) => {
      if (String(line.accountCode) !== accountCode) return;
      const amount = signedBankLine(line, currency);
      if (!currencyMinorUnits(amount, currency)) return;
      lines.push({
        key: `${entry._id.toHexString()}:${lineIndex}`, journalEntryId: entry._id, lineIndex,
        entryNo: String(entry.entryNo || ""), businessDate: entry.businessDate ? String(entry.businessDate).slice(0, 10) : dateKey(entry.date),
        memo: String(entry.memo || ""), reference: String(entry.reference || ""), amount,
      });
    });
  }
  if (entries.length > 2000 || lines.length > 3000) throw new BankReconciliationError("This account has too many ledger transactions for one reconciliation view. Use a shorter statement period or archive older completed periods.", 422);
  return lines;
}

async function loadMatchedKeys(db: Db, lines: LedgerLine[], session?: ClientSession) {
  if (!lines.length) return new Set<string>();
  const entryIds = [...new Map(lines.map(line => [line.journalEntryId.toHexString(), line.journalEntryId])).values()];
  const matches = await db.collection("bankReconciliationMatches").find(
    { journalEntryId: { $in: entryIds } },
    { projection: { journalEntryId: 1, lineIndex: 1 }, ...(session ? { session } : {}) },
  ).toArray();
  return new Set(matches.map(match => `${match.journalEntryId.toHexString()}:${match.lineIndex}`));
}

async function ledgerBalance(db: Db, accountCode: string, through: Date, currency: string, session?: ClientSession) {
  const result = await db.collection("journalEntries").aggregate([
    { $match: { status: "POSTED", date: { $lte: through }, "lines.accountCode": accountCode } },
    { $unwind: "$lines" },
    { $match: { "lines.accountCode": accountCode } },
    { $group: { _id: null, debit: { $sum: "$lines.debit" }, credit: { $sum: "$lines.credit" } } },
  ], session ? { session } : {}).toArray();
  return roundCurrency(Number(result[0]?.debit || 0) - Number(result[0]?.credit || 0), currency);
}

async function detailPayload(db: Db, reconciliation: Record<string, any>) {
  const currency = String(reconciliation.currency);
  const rows = (Array.isArray(reconciliation.rows) ? reconciliation.rows : []).map((row: Record<string, any>) => ({
    ...row, rowId: row.rowId.toHexString(), date: dateKey(row.date), amount: Number(row.amount),
  }));
  // Locked working papers must remain readable without recalculating evidence
  // from a ledger that may have grown or changed after completion.
  if (reconciliation.status !== "DRAFT") return { ...reconciliation, rows, candidates: [], suggestions: {} };
  const lines = await loadLedgerLines(db, String(reconciliation.accountCode), dateKey(reconciliation.statementDate), currency);
  const matched = await loadMatchedKeys(db, lines);
  const candidates = lines.filter(line => !matched.has(line.key));
  const suggestions = suggestBankMatches(rows, candidates.map(candidate => ({ key: candidate.key, businessDate: candidate.businessDate, amount: candidate.amount })), currency);
  return { ...reconciliation, rows, candidates, suggestions };
}

export async function GET(request: Request) {
  const auth = await authorize("accounting.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = new URL(request.url).searchParams.get("id") || "";
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The reconciliation reference is invalid.", 422);
      const reconciliation = await db.collection("bankReconciliations").findOne({ _id: new ObjectId(id) });
      return reconciliation ? ok(serialise(await detailPayload(db, reconciliation))) : fail("This reconciliation could not be found.", 404);
    }
    const [reconciliations, accounts] = await Promise.all([
      db.collection("bankReconciliations").find({}).project({ rows: 0, unclearedLedgerLines: 0, matchedPriorLines: 0 }).sort({ statementDate: -1, createdAt: -1 }).limit(100).toArray(),
      db.collection("chartOfAccounts").find({ type: "ASSET", cashEquivalent: true, active: { $ne: false } }).project({ code: 1, name: 1 }).sort({ code: 1 }).toArray(),
    ]);
    return ok(serialise({ reconciliations, accounts }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = bankReconciliationInputSchema.safeParse(body.value);
  if (!input.success) return fail("Check the bank statement.", 422, input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const result = await session.withTransaction(async () => {
        if (input.data.clientRequestId) {
          const existing = await db.collection("bankReconciliations").findOne({ clientRequestId: input.data.clientRequestId }, { session });
          if (existing) return { reconciliation: existing, isNew: false };
        }
        const [business, account, open, overlap] = await Promise.all([
          db.collection("settings").findOne({ key: "business" }, { session }),
          db.collection("chartOfAccounts").findOne({ code: input.data.accountCode, type: "ASSET", cashEquivalent: true, active: { $ne: false } }, { session }),
          db.collection("bankReconciliations").findOne({ accountCode: input.data.accountCode, status: "DRAFT" }, { session }),
          db.collection("bankReconciliations").findOne({
            accountCode: input.data.accountCode, status: { $ne: "VOID" },
            statementStartDate: { $lte: new Date(`${input.data.statementDate}T00:00:00.000Z`) },
            statementDate: { $gte: new Date(`${input.data.statementStartDate}T00:00:00.000Z`) },
          }, { session }),
        ]);
        if (!account) throw new BankReconciliationError("Choose an active bank or cash-equivalent ledger account.", 422);
        if (open) throw new BankReconciliationError(`Complete or void ${open.reconciliationNo} before importing another statement for this account.`);
        if (overlap) throw new BankReconciliationError(`This period overlaps ${overlap.reconciliationNo}. Use a non-overlapping statement range.`);
        const settings = normaliseBusinessSettings(business);
        const currency = settings.currency;
        const rows = input.data.rows.map(row => ({
          rowId: new ObjectId(), date: row.date, description: row.description, reference: row.reference,
          amount: roundCurrency(row.amount, currency), status: "UNMATCHED",
        }));
        if (rows.some((row, index) => currencyMinorUnits(row.amount, currency) !== currencyMinorUnits(input.data.rows[index].amount, currency)
          || Math.abs(row.amount - input.data.rows[index].amount) > 1e-8)) {
          throw new BankReconciliationError(`Use the supported decimal precision for ${currency}.`, 422);
        }
        const openingBalance = roundCurrency(input.data.openingBalance, currency);
        const closingBalance = roundCurrency(input.data.closingBalance, currency);
        if (Math.abs(openingBalance - input.data.openingBalance) > 1e-8 || Math.abs(closingBalance - input.data.closingBalance) > 1e-8) {
          throw new BankReconciliationError(`Use the supported decimal precision for ${currency}.`, 422);
        }
        assertStatementArithmetic(openingBalance, closingBalance, rows, currency);
        const now = new Date();
        const reconciliation = {
          _id: new ObjectId(), reconciliationNo: makeDocumentNo("BR"),
          ...(input.data.clientRequestId ? { clientRequestId: input.data.clientRequestId } : {}),
          accountCode: String(account.code), accountName: String(account.name), currency, timeZone: settings.timeZone,
          statementStartDate: new Date(`${input.data.statementStartDate}T00:00:00.000Z`),
          statementDate: new Date(`${input.data.statementDate}T00:00:00.000Z`),
          openingBalance, closingBalance, statementMovement: statementMovement(rows, currency),
          rowCount: rows.length, matchedCount: 0, rows, status: "DRAFT",
          createdBy: new ObjectId(auth.session.id), createdAt: now, updatedAt: now,
        };
        await db.collection("bankReconciliations").insertOne(reconciliation, { session });
        await writeAudit(db, auth.session, "bank_reconciliation.import", "bankReconciliation", reconciliation._id.toHexString(), { reconciliationNo: reconciliation.reconciliationNo, accountCode: reconciliation.accountCode, rowCount: rows.length, statementDate: input.data.statementDate }, session);
        return { reconciliation, isNew: true };
      });
      return result.isNew ? created(serialise(result.reconciliation)) : ok(serialise(result.reconciliation));
    } finally { await session.endSession(); }
  } catch (error) {
    if (input.data.clientRequestId && (error as { code?: number }).code === 11000) {
      const existing = await (await getDb()).collection("bankReconciliations").findOne({ clientRequestId: input.data.clientRequestId });
      if (existing) return ok(serialise(existing));
    }
    if (error instanceof BankReconciliationError) return fail(error.message, error.status);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const parsed = bankReconciliationActionSchema.safeParse(body.value);
  if (!parsed.success) return fail("Check the reconciliation action.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  try {
    const db = await getDb();
    const session = (await getMongoClient()).startSession();
    try {
      const reconciliation = await session.withTransaction(async () => {
        const _id = new ObjectId(input.id);
        const current = await db.collection("bankReconciliations").findOne({ _id }, { session });
        if (!current) throw new BankReconciliationError("This reconciliation could not be found.", 404);
        if (input.action === "COMPLETE" && current.status === "COMPLETED") return current;
        assertBankReconciliationVersion(current.updatedAt, input.expectedUpdatedAt);
        if (current.status !== "DRAFT") throw new BankReconciliationError("Only a draft reconciliation can be changed.");
        const rows: Array<Record<string, any> & { amount: number }> = Array.isArray(current.rows)
          ? current.rows.map((row: Record<string, any>) => ({ ...row, amount: Number(row.amount) }))
          : [];
        const updatedAt = nextBankReconciliationUpdatedAt(current.updatedAt);
        const versionFilter = { _id, status: "DRAFT", updatedAt: current.updatedAt };
        const currency = String(current.currency);

        if (input.action === "MATCH") {
          const row = rows.find((candidate: Record<string, any>) => candidate.rowId.equals(new ObjectId(input.rowId!)));
          if (!row) throw new BankReconciliationError("This statement row could not be found.", 404);
          if (row.matchedJournalEntryId) throw new BankReconciliationError("This statement row is already matched.");
          const journalEntryId = new ObjectId(input.journalEntryId!);
          const entry = await db.collection("journalEntries").findOne({ _id: journalEntryId, status: "POSTED", date: { $lte: current.statementDate } }, { session });
          const line = Array.isArray(entry?.lines) ? entry.lines[input.lineIndex!] : null;
          if (!entry || !line || String(line.accountCode) !== current.accountCode) throw new BankReconciliationError("Choose an available ledger line for this bank account.", 422);
          const entryBusinessDate = entry.businessDate ? String(entry.businessDate).slice(0, 10) : dateKey(entry.date);
          if (entryBusinessDate > dateKey(current.statementDate)) throw new BankReconciliationError("A ledger transaction after the statement date cannot be matched.", 422);
          assertBankMatch(Number(row.amount), line, currency);
          const match = {
            _id: new ObjectId(), reconciliationId: _id, rowId: row.rowId, journalEntryId, lineIndex: input.lineIndex,
            accountCode: current.accountCode, amount: row.amount, createdBy: new ObjectId(auth.session.id), createdAt: updatedAt,
          };
          try { await db.collection("bankReconciliationMatches").insertOne(match, { session }); }
          catch (error) { if ((error as { code?: number }).code === 11000) throw new BankReconciliationError("That statement row or ledger line is already matched."); throw error; }
          Object.assign(row, { status: "MATCHED", matchedJournalEntryId: journalEntryId, matchedLineIndex: input.lineIndex, matchedEntryNo: entry.entryNo, matchedBusinessDate: entryBusinessDate, matchedMemo: entry.memo, matchedAt: updatedAt, matchedBy: new ObjectId(auth.session.id) });
          const updated = await db.collection("bankReconciliations").findOneAndUpdate(versionFilter, { $set: { rows, matchedCount: Number(current.matchedCount || 0) + 1, updatedAt } }, { returnDocument: "after", session });
          if (!updated) throw new BankReconciliationError("This reconciliation changed. Refresh it before matching.");
          await writeAudit(db, auth.session, "bank_reconciliation.match", "bankReconciliation", input.id, { reconciliationNo: current.reconciliationNo, rowId: input.rowId, entryNo: entry.entryNo, amount: row.amount }, session);
          return updated;
        }

        if (input.action === "UNMATCH") {
          const row = rows.find((candidate: Record<string, any>) => candidate.rowId.equals(new ObjectId(input.rowId!)));
          if (!row) throw new BankReconciliationError("This statement row could not be found.", 404);
          if (!row.matchedJournalEntryId) throw new BankReconciliationError("This statement row is not matched.");
          await db.collection("bankReconciliationMatches").deleteOne({ reconciliationId: _id, rowId: row.rowId }, { session });
          const previousEntryNo = row.matchedEntryNo;
          for (const key of ["matchedJournalEntryId", "matchedLineIndex", "matchedEntryNo", "matchedBusinessDate", "matchedMemo", "matchedAt", "matchedBy"]) delete row[key];
          row.status = "UNMATCHED";
          const updated = await db.collection("bankReconciliations").findOneAndUpdate(versionFilter, { $set: { rows, matchedCount: Math.max(0, Number(current.matchedCount || 0) - 1), updatedAt } }, { returnDocument: "after", session });
          if (!updated) throw new BankReconciliationError("This reconciliation changed. Refresh it before unmatching.");
          await writeAudit(db, auth.session, "bank_reconciliation.unmatch", "bankReconciliation", input.id, { reconciliationNo: current.reconciliationNo, rowId: input.rowId, entryNo: previousEntryNo }, session);
          return updated;
        }

        if (input.action === "VOID") {
          await db.collection("bankReconciliationMatches").deleteMany({ reconciliationId: _id }, { session });
          const updated = await db.collection("bankReconciliations").findOneAndUpdate(versionFilter, { $set: { status: "VOID", voidReason: input.note, voidedAt: updatedAt, voidedBy: new ObjectId(auth.session.id), updatedAt } }, { returnDocument: "after", session });
          if (!updated) throw new BankReconciliationError("This reconciliation changed. Refresh it before voiding.");
          await writeAudit(db, auth.session, "bank_reconciliation.void", "bankReconciliation", input.id, { reconciliationNo: current.reconciliationNo, reason: input.note }, session);
          return updated;
        }

        if (rows.some((row: Record<string, any>) => !row.matchedJournalEntryId)) throw new BankReconciliationError("Match every imported bank transaction before completing the reconciliation.", 422);
        assertStatementArithmetic(Number(current.openingBalance), Number(current.closingBalance), rows, currency);
        const throughKey = dateKey(current.statementDate);
        const startKey = dateKey(current.statementStartDate);
        const lines = await loadLedgerLines(db, String(current.accountCode), throughKey, currency, session);
        const matchedKeys = await loadMatchedKeys(db, lines, session);
        const currentUncleared = lines.filter(line => line.businessDate >= startKey && !matchedKeys.has(line.key));
        const currentMatchedIds = new Set(rows.map((row: Record<string, any>) => `${row.matchedJournalEntryId.toHexString()}:${row.matchedLineIndex}`));
        const matchedPrior = lines.filter(line => line.businessDate < startKey && currentMatchedIds.has(line.key));
        const [ledgerOpeningBalance, ledgerClosingBalance] = await Promise.all([
          ledgerBalance(db, String(current.accountCode), new Date(Date.parse(`${startKey}T00:00:00.000Z`) - 1), currency, session),
          ledgerBalance(db, String(current.accountCode), new Date(`${throughKey}T23:59:59.999Z`), currency, session),
        ]);
        const summary = bankReconciliationSummary({
          ledgerOpeningBalance, ledgerClosingBalance,
          statementOpeningBalance: Number(current.openingBalance), statementClosingBalance: Number(current.closingBalance),
          unmatchedCurrent: currentUncleared, matchedPrior,
        }, currency);
        if (currencyMinorUnits(summary.difference, currency) !== 0) throw new BankReconciliationError(`The reconciliation still differs by ${summary.difference} ${currency}. Review the statement opening balance and uncleared ledger items.`, 422);
        const updated = await db.collection("bankReconciliations").findOneAndUpdate(versionFilter, { $set: {
          status: "COMPLETED", reviewNote: input.note, completedAt: updatedAt, completedBy: new ObjectId(auth.session.id), updatedAt,
          ledgerOpeningBalance, ledgerClosingBalance, ...summary,
          unclearedLedgerLines: currentUncleared.map(line => ({ journalEntryId: line.journalEntryId, lineIndex: line.lineIndex, entryNo: line.entryNo, businessDate: line.businessDate, memo: line.memo, reference: line.reference, amount: line.amount })),
          matchedPriorLines: matchedPrior.map(line => ({ journalEntryId: line.journalEntryId, lineIndex: line.lineIndex, entryNo: line.entryNo, businessDate: line.businessDate, memo: line.memo, reference: line.reference, amount: line.amount })),
        } }, { returnDocument: "after", session });
        if (!updated) throw new BankReconciliationError("This reconciliation changed. Refresh it before completing.");
        await writeAudit(db, auth.session, "bank_reconciliation.complete", "bankReconciliation", input.id, { reconciliationNo: current.reconciliationNo, accountCode: current.accountCode, statementDate: throughKey, closingBalance: current.closingBalance, ledgerClosingBalance, unclearedCount: currentUncleared.length }, session);
        return updated;
      });
      return ok(serialise(reconciliation));
    } finally { await session.endSession(); }
  } catch (error) {
    if (error instanceof BankReconciliationError) return fail(error.message, error.status);
    return publicError(error);
  }
}
