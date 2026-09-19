import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { AccountingPeriodClosedError } from "@/lib/accounting-periods";
import { assertAccountingPeriodOpen } from "@/lib/accounting-period-lock";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { expenseAmounts, expenseClaimActionSchema, expenseClaimInputSchema, ensureExpenseAccounts } from "@/lib/expenses";
import { makeDocumentNo, serialise } from "@/lib/format";
import { prepareJournalAmounts } from "@/lib/journals";
import { hasPermission } from "@/lib/rbac";
import { getAttachmentStorageConfig } from "@/lib/attachment-storage";
import { ensureProcurementAccounts } from "@/lib/procurement";
import { applyDimensionAllocation, dimensionRuleAuditId, resolveDimensionAllocation } from "@/lib/dimension-allocation";

export const runtime = "nodejs";
class ExpenseConflictError extends Error {}

export async function GET() {
  const auth = await authorize("expenses.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const canReview = hasPermission(auth.session.role, "expenses.approve") || hasPermission(auth.session.role, "expenses.pay");
    const claimFilter = canReview ? {} : { claimantId: new ObjectId(auth.session.id) };
    const [claims, expenseAccounts, paymentAccounts, storage] = await Promise.all([
      db.collection("expenseClaims").find(claimFilter).sort({ createdAt: -1 }).limit(500).toArray(),
      db.collection("chartOfAccounts").find({ type: "EXPENSE", active: { $ne: false } }).project({ code: 1, name: 1 }).sort({ code: 1 }).toArray(),
      hasPermission(auth.session.role, "expenses.pay") ? db.collection("chartOfAccounts").find({ type: "ASSET", active: { $ne: false }, $or: [{ cashEquivalent: true }, { code: { $in: ["1000", "1010"] } }] }).project({ code: 1, name: 1 }).sort({ code: 1 }).toArray() : [],
      getAttachmentStorageConfig(db),
    ]);
    const attachments = claims.length ? await db.collection("expenseAttachments").find({ claimId: { $in: claims.map(claim => claim._id) }, status: { $ne: "REMOVED" } }, { projection: { claimId: 1, originalName: 1, mimeType: 1, originalSize: 1, storedSize: 1, encoding: 1, createdByName: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray() : [];
    return ok(serialise({ claims, attachments, expenseAccounts, paymentAccounts, storageConfigured: Boolean(storage), permissions: { approve: hasPermission(auth.session.role, "expenses.approve"), pay: hasPermission(auth.session.role, "expenses.pay"), ownerSelfReview: auth.session.role === "OWNER" } }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("expenses.submit");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = expenseClaimInputSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the expense claim.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const existing = await db.collection("expenseClaims").findOne({ clientRequestId: input.data.clientRequestId, claimantId: new ObjectId(auth.session.id) });
    if (existing) return ok(serialise(existing));
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const today = dateKeyInTimeZone(new Date(), business.timeZone);
    if (input.data.expenseDate > today) return fail("Expense date cannot be in the future.", 422);
    await ensureExpenseAccounts(db, new ObjectId(auth.session.id));
    const account = await db.collection("chartOfAccounts").findOne({ code: input.data.expenseAccountCode, type: "EXPENSE", active: { $ne: false } });
    if (!account) return fail("Choose an active expense account.", 422);
    let amounts;
    try { amounts = expenseAmounts(input.data.amount, input.data.taxAmount, business.currency); }
    catch (error) { return fail(error instanceof Error ? error.message : "Check the claim amounts.", 422); }
    const now = new Date();
    const document = {
      clientRequestId: input.data.clientRequestId, claimNo: makeDocumentNo("EXP"), claimantId: new ObjectId(auth.session.id), claimantName: auth.session.fullName,
      expenseDate: input.data.expenseDate, merchant: input.data.merchant, category: input.data.category, description: input.data.description,
      ...amounts, currency: business.currency, timeZone: business.timeZone, expenseAccountCode: account.code, expenseAccountName: account.name,
      attachmentCount: 0, status: "DRAFT", history: [{ action: "CREATED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }], createdAt: now, updatedAt: now,
    };
    const result = await db.collection("expenseClaims").insertOne(document);
    await writeAudit(db, auth.session, "expense_claim.create", "expenseClaim", result.insertedId.toHexString(), { claimNo: document.claimNo, amount: document.amount, currency: document.currency });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("This claim request was already recorded.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("expenses.submit");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let parsed: ReturnType<typeof expenseClaimActionSchema.safeParse>;
  try { parsed = expenseClaimActionSchema.safeParse(await request.json()); } catch { return fail("The request body must be valid JSON.", 400); }
  if (!parsed.success || !ObjectId.isValid(parsed.data?.id || "")) return fail("Check the expense action.", 422, parsed.success ? undefined : parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  if (["APPROVE", "REJECT"].includes(input.action) && !hasPermission(auth.session.role, "expenses.approve")) return fail("You do not have permission to review expense claims.", 403);
  if (input.action === "PAY" && !hasPermission(auth.session.role, "expenses.pay")) return fail("You do not have permission to pay expense claims.", 403);
  try {
    const db = await getDb();
    const claimId = new ObjectId(input.id);
    const now = new Date();
    if (input.action === "SUBMIT") {
      const claim = await db.collection("expenseClaims").findOne({ _id: claimId, claimantId: new ObjectId(auth.session.id), status: "DRAFT" });
      if (!claim) return fail("Only your own draft claim can be submitted.", 409);
      if (Number(claim.attachmentCount || 0) < 1) return fail("Attach at least one receipt or supporting document before submitting.", 409);
      const updated = await db.collection("expenseClaims").findOneAndUpdate({ _id: claimId, claimantId: claim.claimantId, status: "DRAFT", attachmentCount: { $gte: 1 } }, { $set: { status: "SUBMITTED", submittedAt: now, updatedAt: now, history: [...(Array.isArray(claim.history) ? claim.history : []), { action: "SUBMITTED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }] } }, { returnDocument: "after" });
      if (!updated) return fail("The claim changed before submission. Reload and try again.", 409);
      await writeAudit(db, auth.session, "expense_claim.submit", "expenseClaim", input.id, { claimNo: claim.claimNo, amount: claim.amount });
      return ok(serialise(updated));
    }
    if (input.action === "APPROVE" || input.action === "REJECT") {
      const claim = await db.collection("expenseClaims").findOne({ _id: claimId, status: "SUBMITTED" });
      if (!claim) return fail("This claim is no longer waiting for review.", 409);
      if (String(claim.claimantId) === auth.session.id && auth.session.role !== "OWNER") return fail("You cannot approve or reject your own expense claim.", 409);
      const status = input.action === "APPROVE" ? "APPROVED" : "REJECTED";
      const updated = await db.collection("expenseClaims").findOneAndUpdate({ _id: claimId, status: "SUBMITTED" }, { $set: { status, reviewNote: input.note, reviewedBy: new ObjectId(auth.session.id), reviewedByName: auth.session.fullName, reviewedAt: now, updatedAt: now, history: [...(Array.isArray(claim.history) ? claim.history : []), { action: status, by: new ObjectId(auth.session.id), byName: auth.session.fullName, note: input.note, at: now }] } }, { returnDocument: "after" });
      if (!updated) return fail("Another reviewer already changed this claim.", 409);
      await writeAudit(db, auth.session, `expense_claim.${input.action.toLowerCase()}`, "expenseClaim", input.id, { claimNo: claim.claimNo, amount: claim.amount, note: input.note });
      return ok(serialise(updated));
    }
    const duplicate = await db.collection("expensePayments").findOne({ clientRequestId: input.clientRequestId });
    if (duplicate) return ok(serialise({ claim: await db.collection("expenseClaims").findOne({ _id: duplicate.claimId }), payment: duplicate }));
    const client = await getMongoClient();
    const session = client.startSession();
    let result: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(async () => {
        const claim = await db.collection("expenseClaims").findOne({ _id: claimId, status: "APPROVED" }, { session });
        if (!claim) throw new ExpenseConflictError("This claim is no longer approved and awaiting payment.");
        const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }, { session }));
        const today = dateKeyInTimeZone(now, business.timeZone);
        if (input.paymentDate < String(claim.expenseDate) || input.paymentDate > today) throw new ExpenseConflictError("Payment date cannot precede the expense or be in the future.");
        await assertAccountingPeriodOpen(db, input.paymentDate, session);
        await ensureProcurementAccounts(db, new ObjectId(auth.session.id), session);
        const paymentAccount = await db.collection("chartOfAccounts").findOne({ code: input.paymentAccountCode, type: "ASSET", active: { $ne: false }, $or: [{ cashEquivalent: true }, { code: { $in: ["1000", "1010"] } }] }, { session });
        if (!paymentAccount) throw new ExpenseConflictError("Choose an active cash or bank account.");
        const taxAccount = Number(claim.taxAmount) > 0 ? await db.collection("chartOfAccounts").findOne({ code: "1300", type: "ASSET", active: { $ne: false } }, { session }) : null;
        if (Number(claim.taxAmount) > 0 && !taxAccount) throw new ExpenseConflictError("Activate the 1300 input tax account before paying this tax-bearing claim.");
        const journal = prepareJournalAmounts([
          { accountCode: String(claim.expenseAccountCode), accountName: String(claim.expenseAccountName), debit: Number(claim.expenseAmount), credit: 0 },
          ...(Number(claim.taxAmount) > 0 ? [{ accountCode: "1300", accountName: String(taxAccount?.name), debit: Number(claim.taxAmount), credit: 0 }] : []),
          { accountCode: String(paymentAccount.code), accountName: String(paymentAccount.name), debit: 0, credit: Number(claim.amount) },
        ], String(claim.currency));
        const dimensionAllocation = await resolveDimensionAllocation(db, "EXPENSE_ACCOUNT", String(claim.expenseAccountCode), session);
        const allocatedJournal = { ...journal, lines: applyDimensionAllocation(journal.lines, dimensionAllocation, String(claim.currency)) };
        const paymentId = new ObjectId(), paymentNo = makeDocumentNo("EPM"), entryNo = makeDocumentNo("JE");
        const updated = await db.collection("expenseClaims").findOneAndUpdate({ _id: claimId, status: "APPROVED" }, { $set: { status: "PAID", paidAt: now, paymentDate: input.paymentDate, paymentNo, paymentReference: input.reference, paidBy: new ObjectId(auth.session.id), paidByName: auth.session.fullName, updatedAt: now, history: [...(Array.isArray(claim.history) ? claim.history : []), { action: "PAID", by: new ObjectId(auth.session.id), byName: auth.session.fullName, note: input.note, at: now }] } }, { returnDocument: "after", session });
        if (!updated) throw new ExpenseConflictError("The claim changed while payment was posting.");
        const payment = { _id: paymentId, clientRequestId: input.clientRequestId, paymentNo, claimId, claimNo: claim.claimNo, claimantId: claim.claimantId, claimantName: claim.claimantName, amount: claim.amount, currency: claim.currency, paymentDate: input.paymentDate, paymentAccountCode: paymentAccount.code, paymentAccountName: paymentAccount.name, reference: input.reference, note: input.note, journalEntryNo: entryNo, ...(dimensionAllocation ? { dimensionAllocation } : {}), createdBy: new ObjectId(auth.session.id), createdByName: auth.session.fullName, createdAt: now };
        await db.collection("expensePayments").insertOne(payment, { session });
        await db.collection("journalEntries").insertOne({ entryNo, date: new Date(`${input.paymentDate}T00:00:00.000Z`), businessDate: input.paymentDate, timeZone: business.timeZone, memo: `Expense payment ${paymentNo} · ${claim.claimantName}`, reference: input.reference, source: "EXPENSE_PAYMENT", sourceId: paymentId, status: "POSTED", ...allocatedJournal, createdBy: new ObjectId(auth.session.id), createdAt: now }, { session });
        await writeAudit(db, auth.session, "expense_claim.pay", "expenseClaim", input.id, { claimNo: claim.claimNo, paymentNo, amount: claim.amount, entryNo, reference: input.reference, dimensionRuleId: dimensionRuleAuditId(dimensionAllocation) }, session);
        result = { claim: updated, payment };
      });
    } finally { await session.endSession(); }
    return ok(serialise(result));
  } catch (error) {
    if (error instanceof AccountingPeriodClosedError) return fail(error.message, error.status);
    if (error instanceof ExpenseConflictError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("This expense action was already recorded. Reload the register.", 409);
    return publicError(error);
  }
}
