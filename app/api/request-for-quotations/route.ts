import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { readExchangeRate } from "@/lib/exchange-rates";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";
import { approvalRequiresDifferentMaker, requestForQuotationActionSchema, requestForQuotationInputSchema } from "@/lib/procurement";

export const runtime = "nodejs";

class RfqConflictError extends Error {}

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
    const rfqs = await db.collection("requestForQuotations").find({}, { projection: { history: 0 } }).sort({ createdAt: -1 }).limit(150).toArray();
    return ok(serialise(rfqs));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = requestForQuotationInputSchema.safeParse(body.value);
  if (!input.success) return fail("Check the request for quotation.", 422, input.error.flatten().fieldErrors);
  if (!ObjectId.isValid(input.data.sourceRequisitionId) || input.data.supplierIds.some((id) => !ObjectId.isValid(id))) return fail("A requisition or supplier reference is invalid.", 422);
  try {
    const db = await getDb();
    const requisitionId = new ObjectId(input.data.sourceRequisitionId);
    const supplierIds = input.data.supplierIds.map((id) => new ObjectId(id));
    const [requisition, suppliers, settingsDocument] = await Promise.all([
      db.collection("purchaseRequisitions").findOne({ _id: requisitionId, status: "APPROVED" }),
      db.collection("suppliers").find({ _id: { $in: supplierIds }, active: { $ne: false } }).toArray(),
      db.collection("settings").findOne({ key: "business" }),
    ]);
    if (!requisition) return fail("Only a current approved purchase requisition can start an RFQ.", 409);
    if (suppliers.length !== supplierIds.length) return fail("Choose at least two active suppliers.", 422);
    const settings = normaliseBusinessSettings(settingsDocument);
    const today = dateKeyInTimeZone(new Date(), settings.timeZone);
    const responseDueDate = documentDateKey(input.data.responseDueDate);
    if (responseDueDate < today) return fail("The quotation response deadline cannot be in the past.", 422);
    if (responseDueDate > documentDateKey(requisition.requiredDate)) return fail("The quotation response deadline cannot be later than the requested need date.", 422);
    const supplierMap = new Map(suppliers.map((supplier) => [supplier._id.toHexString(), supplier]));
    const invitedSuppliers = input.data.supplierIds.map((id) => {
      const supplier = supplierMap.get(id)!;
      return { supplierId: supplier._id, supplierCode: String(supplier.code), supplierName: String(supplier.name), currency: String(supplier.currency) };
    });
    const client = await getMongoClient();
    const session = client.startSession();
    const now = new Date();
    let document: Record<string, unknown> | null = null;
    let existing = false;
    try {
      await session.withTransaction(async () => {
        await touchBusinessKeyLock(db, businessKeyLockId("RFQ_REQUEST", input.data.clientRequestId), session, now);
        await touchBusinessKeyLock(db, businessKeyLockId("RFQ_SOURCE_REQUISITION", input.data.sourceRequisitionId), session, now);
        const duplicate = await db.collection("requestForQuotations").findOne({ clientRequestId: input.data.clientRequestId }, { session });
        if (duplicate) {
          if (String(duplicate.sourceRequisitionId) !== input.data.sourceRequisitionId) throw new RfqConflictError("This request key is already attached to a different requisition.");
          document = duplicate;
          existing = true;
          return;
        }
        const current = await db.collection("purchaseRequisitions").findOne({ _id: requisitionId, status: "APPROVED", version: requisition.version }, { session });
        if (!current) throw new RfqConflictError("The requisition changed or has already entered sourcing.");
        const _id = new ObjectId();
        const rfqNo = makeDocumentNo("RFQ");
        document = {
          _id,
          clientRequestId: input.data.clientRequestId,
          rfqNo,
          sourceRequisitionId: requisitionId,
          sourceRequisitionNo: current.requisitionNo,
          locationId: current.locationId,
          locationCode: current.locationCode,
          locationName: current.locationName,
          requiredDate: current.requiredDate,
          priority: current.priority,
          justification: current.justification,
          items: current.items,
          invitedSuppliers,
          responseDueDate: input.data.responseDueDate,
          notes: input.data.notes,
          quotes: [],
          status: "OPEN",
          version: 1,
          createdBy: new ObjectId(auth.session.id),
          createdByName: auth.session.fullName,
          createdAt: now,
          updatedAt: now,
          history: [{ action: "OPENED", supplierCount: invitedSuppliers.length, by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now }],
        };
        await db.collection("requestForQuotations").insertOne(document, { session });
        const updated = await db.collection("purchaseRequisitions").updateOne(
          { _id: requisitionId, status: "APPROVED", version: current.version },
          { $set: { status: "SOURCING", sourceRfqId: _id, sourceRfqNo: rfqNo, sourcingAt: now, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "RFQ_OPENED", rfqId: _id, rfqNo, by: new ObjectId(auth.session.id), byName: auth.session.fullName, at: now } } as never },
          { session },
        );
        if (!updated.modifiedCount) throw new RfqConflictError("The requisition changed while sourcing was being opened.");
        await writeAudit(db, auth.session, "rfq.open", "requestForQuotation", _id.toHexString(), { rfqNo, sourceRequisitionNo: current.requisitionNo, supplierCount: invitedSuppliers.length }, session);
        await writeAudit(db, auth.session, "purchase_requisition.source", "purchaseRequisition", requisitionId.toHexString(), { requisitionNo: current.requisitionNo, rfqNo }, session);
      });
    } finally { await session.endSession(); }
    return existing ? ok(serialise(document)) : created(serialise(document));
  } catch (error) {
    if (error instanceof RfqConflictError) return fail(error.message, 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = requestForQuotationActionSchema.safeParse(body.value);
  if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the RFQ action.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
  const action = input.data;
  const auth = await authorize(action.action === "AWARD" ? "purchasing.approve" : "purchasing.write");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const id = new ObjectId(action.id);
    const now = new Date();
    const actorId = new ObjectId(auth.session.id);
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const client = await getMongoClient();
    const session = client.startSession();
    let saved: Record<string, unknown> | null = null;
    try {
      if (action.action === "SUBMIT_QUOTE") {
        if (!ObjectId.isValid(action.supplierId) || action.items.some((item) => !ObjectId.isValid(item.productId))) return fail("A supplier or product reference is invalid.", 422);
        if (documentDateKey(action.expectedDeliveryDate) < dateKeyInTimeZone(new Date(), settings.timeZone)) return fail("The quoted delivery date cannot be in the past.", 422);
        const [current, supplier] = await Promise.all([
          db.collection("requestForQuotations").findOne({ _id: id, status: "OPEN", version: action.expectedVersion }),
          db.collection("suppliers").findOne({ _id: new ObjectId(action.supplierId), active: { $ne: false } }),
        ]);
        if (!current) throw new RfqConflictError("The RFQ changed or is no longer open. Reload and try again.");
        if (!supplier || !(Array.isArray(current.invitedSuppliers) && current.invitedSuppliers.some((item) => String(item.supplierId) === action.supplierId))) return fail("Choose an active supplier invited to this RFQ.", 422);
        if (Array.isArray(current.quotes) && current.quotes.some((quote) => String(quote.supplierId) === action.supplierId)) throw new RfqConflictError("This supplier already has a recorded quote in the RFQ.");
        const requestedItems = Array.isArray(current.items) ? current.items : [];
        const priceMap = new Map(action.items.map((item) => [item.productId, item.unitCost]));
        if (priceMap.size !== requestedItems.length || requestedItems.some((item) => !priceMap.has(String(item.productId)))) return fail("Quote every requested product exactly once.", 422);
        const exchange = await readExchangeRate(db, settings.currency, String(supplier.currency));
        if (!exchange) return fail(`Configure an active ${settings.currency}/${supplier.currency} exchange rate before recording this quote.`, 409);
        const items = requestedItems.map((item) => {
          const unitCost = roundCurrency(priceMap.get(String(item.productId))!, String(supplier.currency));
          return { productId: item.productId, sku: item.sku, productName: item.productName, unit: item.unit, quantity: Number(item.quantity), unitCost, lineTotal: roundCurrency(unitCost * Number(item.quantity), String(supplier.currency)) };
        });
        if (items.some((item) => currencyMinorUnits(item.unitCost, String(supplier.currency)) <= 0)) return fail(`Every quoted line needs a positive unit cost in ${supplier.currency}.`, 422);
        const subtotal = roundCurrency(items.reduce((sum, item) => sum + item.lineTotal, 0), String(supplier.currency));
        if (Number(supplier.minimumOrder || 0) > subtotal) return fail(`This quote is below the supplier minimum order of ${supplier.currency} ${Number(supplier.minimumOrder).toFixed(2)}.`, 422);
        const quote = {
          _id: new ObjectId(),
          supplierId: supplier._id,
          supplierCode: supplier.code,
          supplierName: supplier.name,
          currency: String(supplier.currency),
          supplierReference: action.supplierReference,
          expectedDeliveryDate: action.expectedDeliveryDate,
          notes: action.notes,
          items,
          subtotal,
          baseCurrency: settings.currency,
          baseSubtotal: roundCurrency(subtotal / exchange.rate, settings.currency),
          exchangeRate: exchange.rate,
          exchangeRateSource: exchange.source,
          exchangeRateEffectiveAt: exchange.effectiveAt,
          recordedBy: actorId,
          recordedByName: auth.session.fullName,
          recordedAt: now,
        };
        await session.withTransaction(async () => {
          const updated = await db.collection("requestForQuotations").findOneAndUpdate(
            { _id: id, status: "OPEN", version: action.expectedVersion, "quotes.supplierId": { $ne: supplier._id } },
            { $push: { quotes: quote, history: { action: "QUOTE_RECORDED", quoteId: quote._id, supplierId: supplier._id, supplierName: supplier.name, by: actorId, byName: auth.session.fullName, at: now } } as never, $inc: { version: 1 }, $set: { updatedAt: now } },
            { returnDocument: "after", session },
          );
          if (!updated) throw new RfqConflictError("The RFQ changed or this supplier quote was already recorded.");
          saved = updated;
          await writeAudit(db, auth.session, "rfq.quote_record", "requestForQuotation", action.id, { rfqNo: updated.rfqNo, supplierCode: supplier.code, subtotal, currency: supplier.currency, baseSubtotal: quote.baseSubtotal }, session);
        });
      } else if (action.action === "AWARD") {
        if (!ObjectId.isValid(action.quoteId)) return fail("The supplier quote reference is invalid.", 422);
        await session.withTransaction(async () => {
          const makerFilter = approvalRequiresDifferentMaker(auth.session.role) ? { createdBy: { $ne: actorId } } : {};
          const current = await db.collection("requestForQuotations").findOne({ _id: id, status: "OPEN", version: action.expectedVersion, ...makerFilter }, { session });
          if (!current) throw new RfqConflictError(approvalRequiresDifferentMaker(auth.session.role) ? "A different authorised user must award a current RFQ." : "The RFQ changed or is no longer open.");
          const quote = Array.isArray(current.quotes) ? current.quotes.find((item) => String(item._id) === action.quoteId) : null;
          if (!quote) throw new RfqConflictError("Choose a current recorded supplier quote.");
          const updated = await db.collection("requestForQuotations").findOneAndUpdate(
            { _id: id, status: "OPEN", version: action.expectedVersion },
            { $set: { status: "AWARDED", winningQuoteId: quote._id, awardedSupplierId: quote.supplierId, awardedSupplierName: quote.supplierName, awardReason: action.reason, awardedAt: now, awardedBy: actorId, awardedByName: auth.session.fullName, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "AWARDED", quoteId: quote._id, supplierId: quote.supplierId, supplierName: quote.supplierName, reason: action.reason, quoteCount: current.quotes.length, by: actorId, byName: auth.session.fullName, at: now } } as never },
            { returnDocument: "after", session },
          );
          if (!updated) throw new RfqConflictError("The RFQ changed while the award was being saved.");
          saved = updated;
          await writeAudit(db, auth.session, "rfq.award", "requestForQuotation", action.id, { rfqNo: current.rfqNo, quoteId: action.quoteId, supplierCode: quote.supplierCode, quoteCount: current.quotes.length, reason: action.reason }, session);
        });
      } else {
        await session.withTransaction(async () => {
          const current = await db.collection("requestForQuotations").findOne({ _id: id, status: { $in: ["OPEN", "AWARDED"] }, version: action.expectedVersion }, { session });
          if (!current) throw new RfqConflictError("The RFQ changed or can no longer be cancelled.");
          const updated = await db.collection("requestForQuotations").findOneAndUpdate(
            { _id: id, status: current.status, version: action.expectedVersion },
            { $set: { status: "CANCELLED", cancellationReason: action.reason, cancelledAt: now, cancelledBy: actorId, cancelledByName: auth.session.fullName, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "CANCELLED", reason: action.reason, by: actorId, byName: auth.session.fullName, at: now } } as never },
            { returnDocument: "after", session },
          );
          if (!updated) throw new RfqConflictError("The RFQ changed while it was being cancelled.");
          const restored = await db.collection("purchaseRequisitions").updateOne(
            { _id: current.sourceRequisitionId, status: "SOURCING", sourceRfqId: id },
            { $set: { status: "APPROVED", updatedAt: now }, $unset: { sourceRfqId: "", sourceRfqNo: "", sourcingAt: "" }, $inc: { version: 1 }, $push: { history: { action: "RFQ_CANCELLED", rfqId: id, rfqNo: current.rfqNo, reason: action.reason, by: actorId, byName: auth.session.fullName, at: now } } as never },
            { session },
          );
          if (!restored.modifiedCount) throw new RfqConflictError("The source requisition changed while the RFQ was being cancelled.");
          saved = updated;
          await writeAudit(db, auth.session, "rfq.cancel", "requestForQuotation", action.id, { rfqNo: current.rfqNo, reason: action.reason }, session);
          await writeAudit(db, auth.session, "purchase_requisition.restore", "purchaseRequisition", String(current.sourceRequisitionId), { requisitionNo: current.sourceRequisitionNo, rfqNo: current.rfqNo }, session);
        });
      }
    } finally { await session.endSession(); }
    return ok(serialise(saved));
  } catch (error) {
    if (error instanceof RfqConflictError) return fail(error.message, 409);
    return publicError(error);
  }
}
