import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { isValidDateKey } from "@/lib/dates";
import { prepareJournalAmounts } from "@/lib/journals";

export const runtime = "nodejs";

const lineSchema = z.object({
  accountCode: z.string().trim().min(3).max(12),
  accountName: z.string().trim().min(2).max(100),
  debit: z.coerce.number().min(0).max(100_000_000),
  credit: z.coerce.number().min(0).max(100_000_000),
}).refine((line) => (line.debit > 0) !== (line.credit > 0), "Each line needs either a debit or a credit.");

const journalSchema = z.object({
  date: z.string().refine(isValidDateKey, "Choose a valid calendar date."),
  memo: z.string().trim().min(3).max(240),
  reference: z.string().trim().max(60).default(""),
  lines: z.array(lineSchema).min(2).max(40),
});

export async function GET() {
  const auth = await authorize("accounting.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const [entries, accounts] = await Promise.all([
      db.collection("journalEntries").find({}).sort({ date: -1, createdAt: -1 }).limit(200).toArray(),
      db.collection("chartOfAccounts").find({ active: { $ne: false } }).sort({ code: 1 }).toArray(),
    ]);
    return ok(serialise({ entries, accounts }));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("accounting.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = journalSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the journal entry.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    let amounts;
    try { amounts = prepareJournalAmounts(input.data.lines, settings.currency); }
    catch (error) { return fail(error instanceof Error ? error.message : "Check the journal amounts.", 422); }
    const { lines, totalDebit, totalCredit } = amounts;
    const accounts = await db.collection("chartOfAccounts").find({ code: { $in: lines.map(line => line.accountCode) }, active: { $ne: false } }).toArray();
    if (lines.some(line => !accounts.some(account => account.code === line.accountCode))) return fail("Choose an active ledger account for every line.", 422);
    const now = new Date();
    const document = {
      entryNo: makeDocumentNo("JE"),
      date: new Date(`${input.data.date}T00:00:00Z`),
      businessDate: input.data.date,
      currency: settings.currency,
      timeZone: settings.timeZone,
      memo: input.data.memo,
      reference: input.data.reference,
      source: "MANUAL",
      status: "POSTED",
      lines: lines.map(line => ({ ...line, accountName: String(accounts.find(account => account.code === line.accountCode)!.name) })),
      totalDebit,
      totalCredit,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
    };
    const _id = new ObjectId();
    const session = (await getMongoClient()).startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection("journalEntries").insertOne({ _id, ...document }, { session });
        await writeAudit(db, auth.session, "journal.post", "journalEntry", _id.toHexString(), { entryNo: document.entryNo, totalDebit }, session);
      });
    } finally { await session.endSession(); }
    return created(serialise({ _id, ...document }));
  } catch (error) {
    return publicError(error);
  }
}
