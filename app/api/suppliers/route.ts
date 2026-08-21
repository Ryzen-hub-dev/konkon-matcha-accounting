import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { dateKeyInTimeZone } from "@/lib/dates";
import { roundCurrency } from "@/lib/international";
import { supplierInputSchema, supplierPulse, supplierUpdateSchema } from "@/lib/procurement";
import { hasPermission } from "@/lib/rbac";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

const archiveSchema = z.object({ id: z.string().length(24) });

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

function documentDateKey(value: unknown) { return new Date(value as string | number | Date).toISOString().slice(0, 10); }

export async function GET(request: Request) {
  const auth = await authorize("purchasing.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "1" && hasPermission(auth.session.role, "purchasing.write");
    const suppliers = await db.collection("suppliers").find(includeArchived ? {} : { active: { $ne: false } }).sort({ active: -1, name: 1 }).limit(500).toArray();
    const supplierIds = suppliers.map((supplier) => supplier._id);
    const now = new Date();
    const [openOrders, openBills] = supplierIds.length ? await Promise.all([
      db.collection("purchaseOrders").find({ supplierId: { $in: supplierIds }, status: { $in: ["DRAFT", "APPROVED", "PARTIALLY_RECEIVED"] } }, { projection: { supplierId: 1, expectedDate: 1, status: 1, timeZone: 1 } }).toArray(),
      db.collection("accountsPayableBills").find({ supplierId: { $in: supplierIds }, status: { $in: ["OPEN", "PARTIALLY_PAID", "OVERDUE"] } }, { projection: { supplierId: 1, baseBalance: 1 } }).toArray(),
    ]) : [[], []];
    const enriched = suppliers.map((supplier) => {
      const id = supplier._id.toHexString();
      const orders = openOrders.filter((order) => String(order.supplierId) === id);
      const overdueOrderCount = orders.filter((order) => order.status !== "DRAFT" && documentDateKey(order.expectedDate) < dateKeyInTimeZone(now, String(order.timeZone || "UTC"))).length;
      const outstandingBase = roundCurrency(openBills.filter((bill) => String(bill.supplierId) === id).reduce((sum, bill) => sum + Number(bill.baseBalance || 0), 0));
      return {
        ...supplier,
        openOrderCount: orders.length,
        overdueOrderCount,
        outstandingBase,
        pulse: supplierPulse({
          receiptCount: Number(supplier.receiptCount || 0),
          onTimeReceiptCount: Number(supplier.onTimeReceiptCount || 0),
          lateDaysTotal: Number(supplier.lateDaysTotal || 0),
          overdueOrderCount,
        }),
      };
    });
    return ok(serialise(enriched));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = supplierInputSchema.safeParse(body.value);
    if (!input.success) return fail("Check the supplier details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const now = new Date();
    const document = {
      ...input.data,
      code: input.data.code.toUpperCase(),
      active: true,
      receiptCount: 0,
      onTimeReceiptCount: 0,
      lateDaysTotal: 0,
      receivedBaseValue: 0,
      createdBy: new ObjectId(auth.session.id),
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("suppliers").insertOne(document);
    await writeAudit(db, auth.session, "supplier.create", "supplier", result.insertedId.toHexString(), { code: document.code, currency: document.currency });
    return created(serialise({ _id: result.insertedId, ...document, openOrderCount: 0, overdueOrderCount: 0, outstandingBase: 0, pulse: supplierPulse({ receiptCount: 0, onTimeReceiptCount: 0, lateDaysTotal: 0, overdueOrderCount: 0 }) }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That supplier code is already in use.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = supplierUpdateSchema.safeParse(body.value);
    if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the supplier update.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
    const db = await getDb();
    const { id, restore, ...changes } = input.data;
    const supplier = await db.collection("suppliers").findOneAndUpdate(
      { _id: new ObjectId(id), ...(restore ? { active: false } : { active: { $ne: false } }) },
      {
        $set: { ...changes, ...(restore ? { active: true } : {}), updatedAt: new Date(), updatedBy: new ObjectId(auth.session.id) },
        ...(restore ? { $unset: { archivedAt: "", archivedBy: "" } } : {}),
      },
      { returnDocument: "after" },
    );
    if (!supplier) return fail("The supplier no longer exists or is already in that state.", 404);
    await writeAudit(db, auth.session, restore ? "supplier.restore" : "supplier.update", "supplier", id, { fields: Object.keys(changes) });
    return ok(serialise(supplier));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("That supplier code is already in use.", 409);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = archiveSchema.safeParse(body.value);
    if (!input.success || !ObjectId.isValid(input.data.id)) return fail("Check the supplier reference.", 422);
    const db = await getDb();
    const supplierId = new ObjectId(input.data.id);
    const openOrders = await db.collection("purchaseOrders").countDocuments({ supplierId, status: { $in: ["DRAFT", "APPROVED", "PARTIALLY_RECEIVED"] } });
    if (openOrders) return fail("Cancel or receive this supplier's open purchase orders before archiving it.", 409);
    const now = new Date();
    const supplier = await db.collection("suppliers").findOneAndUpdate(
      { _id: supplierId, active: { $ne: false } },
      { $set: { active: false, archivedAt: now, archivedBy: new ObjectId(auth.session.id), updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!supplier) return fail("The supplier is already archived or could not be found.", 404);
    await writeAudit(db, auth.session, "supplier.archive", "supplier", input.data.id, { code: supplier.code });
    return ok({ archived: true });
  } catch (error) { return publicError(error); }
}
