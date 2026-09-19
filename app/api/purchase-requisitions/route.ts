import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { approvalRequiresDifferentMaker, purchaseRequisitionActionSchema, purchaseRequisitionInputSchema } from "@/lib/procurement";

export const runtime = "nodejs";

class RequisitionConflictError extends Error {}

function documentDateKey(value: unknown) {
  return new Date(value as string | number | Date).toISOString().slice(0, 10);
}

async function readBody(request: Request) {
  try { return { value: await request.json() } as const; }
  catch { return { error: fail("The request body must be valid JSON.", 400) } as const; }
}

export async function GET() {
  const auth = await authorize("purchasing.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const requisitions = await db.collection("purchaseRequisitions").find({}).sort({ createdAt: -1 }).limit(300).toArray();
    return ok(serialise(requisitions));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = purchaseRequisitionInputSchema.safeParse(body.value);
  if (!input.success) return fail("Check the purchase requisition.", 422, input.error.flatten().fieldErrors);
  if (!ObjectId.isValid(input.data.locationId) || input.data.items.some((item) => !ObjectId.isValid(item.productId)) || (input.data.suggestedSupplierId && !ObjectId.isValid(input.data.suggestedSupplierId))) return fail("A location, product or supplier reference is invalid.", 422);
  try {
    const db = await getDb();
    const productIds = input.data.items.map((item) => new ObjectId(item.productId));
    const [location, products, supplier, settingsDocument] = await Promise.all([
      db.collection("locations").findOne({ _id: new ObjectId(input.data.locationId), active: { $ne: false } }),
      db.collection("products").find({ _id: { $in: productIds }, active: { $ne: false } }).toArray(),
      input.data.suggestedSupplierId ? db.collection("suppliers").findOne({ _id: new ObjectId(input.data.suggestedSupplierId), active: { $ne: false } }) : null,
      db.collection("settings").findOne({ key: "business" }),
    ]);
    if (!location) return fail("Choose an active receiving location.", 422);
    if (products.length !== productIds.length) return fail("One or more products are archived or unavailable.", 409);
    if (input.data.suggestedSupplierId && !supplier) return fail("Choose an active suggested supplier.", 422);
    const settings = normaliseBusinessSettings(settingsDocument);
    if (documentDateKey(input.data.requiredDate) < dateKeyInTimeZone(new Date(), settings.timeZone)) return fail("The required date cannot be in the past.", 422);
    const productMap = new Map(products.map((product) => [product._id.toHexString(), product]));
    const items = input.data.items.map((line) => {
      const product = productMap.get(line.productId)!;
      return { productId: product._id, sku: String(product.sku), productName: String(product.name), unit: String(product.unit), quantity: line.quantity };
    });
    const client = await getMongoClient();
    const session = client.startSession();
    const now = new Date();
    let document: Record<string, unknown> | null = null;
    let existing = false;
    try {
      await session.withTransaction(async () => {
        await touchBusinessKeyLock(db, businessKeyLockId("PURCHASE_REQUISITION_REQUEST", input.data.clientRequestId), session, now);
        const duplicate = await db.collection("purchaseRequisitions").findOne({ clientRequestId: input.data.clientRequestId }, { session });
        if (duplicate) { document = duplicate; existing = true; return; }
        const _id = new ObjectId();
        document = {
          _id,
          clientRequestId: input.data.clientRequestId,
          requisitionNo: makeDocumentNo("PR"),
          locationId: location._id,
          locationCode: location.code,
          locationName: location.name,
          requiredDate: input.data.requiredDate,
          priority: input.data.priority,
          justification: input.data.justification,
          notes: input.data.notes,
          items,
          suggestedSupplierId: supplier?._id || null,
          suggestedSupplierCode: supplier?.code || "",
          suggestedSupplierName: supplier?.name || "",
          status: "SUBMITTED",
          version: 1,
          createdBy: new ObjectId(auth.session.id),
          createdByName: auth.session.fullName,
          createdAt: now,
          submittedAt: now,
          updatedAt: now,
          history: [{ action: "SUBMITTED", by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }],
        };
        await db.collection("purchaseRequisitions").insertOne(document, { session });
        await writeAudit(db, auth.session, "purchase_requisition.submit", "purchaseRequisition", _id.toHexString(), { requisitionNo: (document as Record<string, unknown>).requisitionNo, priority: input.data.priority, itemCount: items.length }, session);
      });
    } finally { await session.endSession(); }
    return existing ? ok(serialise(document)) : created(serialise(document));
  } catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = purchaseRequisitionActionSchema.safeParse(body.value);
  if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the purchase requisition action.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
  const permission = input.data.action === "CANCEL" ? "purchasing.write" as const : "purchasing.approve" as const;
  const auth = await authorize(permission);
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = new ObjectId(input.data.id);
    const now = new Date();
    const actorId = new ObjectId(auth.session.id);
    const client = await getMongoClient();
    const session = client.startSession();
    let saved: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(async () => {
        if (input.data.action === "CANCEL") {
          const requisition = await db.collection("purchaseRequisitions").findOneAndUpdate(
            { _id: id, status: "SUBMITTED", version: input.data.expectedVersion },
            { $set: { status: "CANCELLED", cancellationReason: input.data.reason, cancelledAt: now, cancelledBy: actorId, cancelledByName: auth.session.fullName, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "CANCELLED", reason: input.data.reason, by: actorId, byName: auth.session.fullName, at: now } } as never },
            { returnDocument: "after", session },
          );
          if (!requisition) throw new RequisitionConflictError("The requisition changed or is no longer awaiting approval. Reload and try again.");
          saved = requisition;
          await writeAudit(db, auth.session, "purchase_requisition.cancel", "purchaseRequisition", input.data.id, { requisitionNo: requisition.requisitionNo, reason: input.data.reason }, session);
          return;
        }
        const makerFilter = approvalRequiresDifferentMaker(auth.session.role) ? { createdBy: { $ne: actorId } } : {};
        if (input.data.action === "APPROVE") {
          const requisition = await db.collection("purchaseRequisitions").findOneAndUpdate(
            { _id: id, status: "SUBMITTED", version: input.data.expectedVersion, ...makerFilter },
            { $set: { status: "APPROVED", approvedAt: now, approvedBy: actorId, approvedByName: auth.session.fullName, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "APPROVED", by: actorId, byName: auth.session.fullName, at: now } } as never },
            { returnDocument: "after", session },
          );
          if (!requisition) throw new RequisitionConflictError(approvalRequiresDifferentMaker(auth.session.role) ? "A different authorised user must approve a current requisition." : "The requisition changed or is no longer awaiting approval.");
          saved = requisition;
          await writeAudit(db, auth.session, "purchase_requisition.approve", "purchaseRequisition", input.data.id, { requisitionNo: requisition.requisitionNo }, session);
          return;
        }
        const requisition = await db.collection("purchaseRequisitions").findOneAndUpdate(
          { _id: id, status: "SUBMITTED", version: input.data.expectedVersion, ...makerFilter },
          { $set: { status: "REJECTED", rejectionReason: input.data.reason, rejectedAt: now, rejectedBy: actorId, rejectedByName: auth.session.fullName, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "REJECTED", reason: input.data.reason, by: actorId, byName: auth.session.fullName, at: now } } as never },
          { returnDocument: "after", session },
        );
        if (!requisition) throw new RequisitionConflictError(approvalRequiresDifferentMaker(auth.session.role) ? "A different authorised user must review a current requisition." : "The requisition changed or is no longer awaiting approval.");
        saved = requisition;
        await writeAudit(db, auth.session, "purchase_requisition.reject", "purchaseRequisition", input.data.id, { requisitionNo: requisition.requisitionNo, reason: input.data.reason }, session);
      });
    } finally { await session.endSession(); }
    return ok(serialise(saved));
  } catch (error) {
    if (error instanceof RequisitionConflictError) return fail(error.message, 409);
    return publicError(error);
  }
}
