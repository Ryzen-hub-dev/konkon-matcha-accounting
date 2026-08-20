import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { asMoney, makeDocumentNo, serialise } from "@/lib/format";

export const runtime = "nodejs";

const lineSchema = z.object({
  accountCode: z.string().trim().min(3).max(12),
  accountName: z.string().trim().min(2).max(100),
  debit: z.coerce.number().min(0).max(100_000_000),
  credit: z.coerce.number().min(0).max(100_000_000),
}).refine((line) => (line.debit > 0) !== (line.credit > 0), "Each line needs either a debit or a credit.");

const journalSchema = z.object({
  date: z.coerce.date(),
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
    const lines = input.data.lines.map((line) => ({ ...line, debit: asMoney(line.debit), credit: asMoney(line.credit) }));
    const totalDebit = asMoney(lines.reduce((sum, line) => sum + line.debit, 0));
    const totalCredit = asMoney(lines.reduce((sum, line) => sum + line.credit, 0));
    if (totalDebit <= 0 || Math.abs(totalDebit - totalCredit) > 0.009) return fail("Debits and credits must balance.", 422);
    const db = await getDb();
    const now = new Date();
    const document = {
      entryNo: makeDocumentNo("JE"),
      date: input.data.date,
      memo: input.data.memo,
      reference: input.data.reference,
      source: "MANUAL",
      status: "POSTED",
      lines,
      totalDebit,
      totalCredit,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
    };
    const result = await db.collection("journalEntries").insertOne(document);
    await writeAudit(db, auth.session, "journal.post", "journalEntry", result.insertedId.toHexString(), { entryNo: document.entryNo, totalDebit });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    return publicError(error);
  }
}
