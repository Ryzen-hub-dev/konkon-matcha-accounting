import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { ensureDefaultPaymentMethods, paymentMethodSchema, paymentMethodUpdateSchema } from "@/lib/payment-methods";

export const runtime = "nodejs";

const archiveSchema = z.object({ id: z.string().length(24) });

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

async function readAssetAccount(accountCode: string) {
  const db = await getDb();
  const account = await db.collection("chartOfAccounts").findOne({ code: accountCode, type: "ASSET", active: { $ne: false } });
  return { db, account };
}

export async function GET(request: Request) {
  const auth = await authorize("payments.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    await ensureDefaultPaymentMethods(db, new ObjectId(auth.session.id));
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "1" && ["OWNER", "ADMIN"].includes(auth.session.role);
    const methods = await db.collection("paymentMethods").find(includeArchived ? {} : { active: { $ne: false } }).sort({ sortOrder: 1, name: 1 }).toArray();
    return ok(serialise(methods));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("payments.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = paymentMethodSchema.safeParse(body.value);
    if (!input.success) return fail("Check the payment method details.", 422, input.error.flatten().fieldErrors);
    const { db, account } = await readAssetAccount(input.data.accountCode);
    if (!account) return fail("Choose an active cash or bank asset account.", 422, { accountCode: ["The ledger account is not available."] });
    const now = new Date();
    const document = { ...input.data, accountName: String(account.name), active: true, createdBy: new ObjectId(auth.session.id), createdAt: now, updatedAt: now };
    const result = await db.collection("paymentMethods").insertOne(document);
    await writeAudit(db, auth.session, "payment_method.create", "paymentMethod", result.insertedId.toHexString(), { code: document.code, accountCode: document.accountCode });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That payment code is already in use.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("payments.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = paymentMethodUpdateSchema.safeParse(body.value);
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the payment method details.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const { id, ...changes } = input.data;
    const { db, account } = changes.accountCode ? await readAssetAccount(changes.accountCode) : { db: await getDb(), account: null };
    if (changes.accountCode && !account) return fail("Choose an active cash or bank asset account.", 422, { accountCode: ["The ledger account is not available."] });
    const current = await db.collection("paymentMethods").findOne({ _id: new ObjectId(id) });
    if (!current) return fail("This payment method could not be found.", 404);
    if (changes.active === false && current.active !== false) {
      const activeCount = await db.collection("paymentMethods").countDocuments({ active: { $ne: false } });
      if (activeCount <= 1) return fail("Keep at least one payment method active.", 409);
    }
    const update = { ...changes, ...(account ? { accountName: String(account.name) } : {}), updatedAt: new Date(), updatedBy: new ObjectId(auth.session.id) };
    await db.collection("paymentMethods").updateOne({ _id: current._id }, { $set: update });
    await writeAudit(db, auth.session, "payment_method.update", "paymentMethod", id, { code: changes.code || current.code, active: changes.active ?? current.active });
    return ok({ updated: true });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That payment code is already in use.", 409);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("payments.manage");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = archiveSchema.safeParse(body.value);
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the payment method reference.", 422);
    const db = await getDb();
    const current = await db.collection("paymentMethods").findOne({ _id: new ObjectId(input.data.id), active: { $ne: false } });
    if (!current) return fail("This payment method is already inactive.", 404);
    if (await db.collection("paymentMethods").countDocuments({ active: { $ne: false } }) <= 1) return fail("Keep at least one payment method active.", 409);
    const now = new Date();
    await db.collection("paymentMethods").updateOne({ _id: current._id }, { $set: { active: false, archivedAt: now, archivedBy: new ObjectId(auth.session.id), updatedAt: now } });
    await writeAudit(db, auth.session, "payment_method.archive", "paymentMethod", input.data.id, { code: current.code });
    return ok({ archived: true });
  } catch (error) { return publicError(error); }
}
