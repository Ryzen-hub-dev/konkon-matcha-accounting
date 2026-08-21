import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { readExchangeRate } from "@/lib/exchange-rates";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";
import { approvalRequiresDifferentMaker, ensureProcurementAccounts, purchaseOrderActionSchema, purchaseOrderInputSchema, suggestedReorderAfterInbound, weightedAverageInventoryCost } from "@/lib/procurement";
import { calculateTaxTotals } from "@/lib/tax";

export const runtime = "nodejs";

class PurchaseConflictError extends Error {}

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
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "";
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The purchase order reference is invalid.", 422);
      const orderId = new ObjectId(id);
      const [order, receipts, bills] = await Promise.all([
        db.collection("purchaseOrders").findOne({ _id: orderId }),
        db.collection("goodsReceipts").find({ purchaseOrderId: orderId }).sort({ receivedAt: -1 }).toArray(),
        db.collection("accountsPayableBills").find({ purchaseOrderId: orderId }).sort({ createdAt: -1 }).toArray(),
      ]);
      if (!order) return fail("This purchase order could not be found.", 404);
      return ok(serialise({ order, receipts, bills }));
    }
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const [orders, products, locations, settings, salesVelocity, inboundStock] = await Promise.all([
      db.collection("purchaseOrders").find({}).sort({ createdAt: -1 }).limit(300).toArray(),
      db.collection("products").find({ active: { $ne: false } }).sort({ category: 1, name: 1 }).limit(500).toArray(),
      db.collection("locations").find({ active: { $ne: false } }).sort({ type: 1, code: 1 }).limit(300).toArray(),
      db.collection("settings").findOne({ key: "business" }),
      db.collection("sales").aggregate([
        { $match: { status: "COMPLETED", createdAt: { $gte: thirtyDaysAgo } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.productId", units: { $sum: "$items.quantity" } } },
      ]).toArray(),
      db.collection("purchaseOrders").aggregate([
        { $match: { status: { $in: ["DRAFT", "APPROVED", "PARTIALLY_RECEIVED"] } } },
        { $unwind: "$items" },
        { $project: { productId: "$items.productId", outstanding: { $max: [0, { $subtract: ["$items.quantity", { $ifNull: ["$items.receivedQuantity", 0] }] }] } } },
        { $group: { _id: "$productId", quantity: { $sum: "$outstanding" } } },
      ]).toArray(),
    ]);
    const business = normaliseBusinessSettings(settings);
    const velocity = new Map(salesVelocity.map((row) => [String(row._id), Number(row.units || 0)]));
    const inbound = new Map(inboundStock.map((row) => [String(row._id), Number(row.quantity || 0)]));
    const reorderSuggestions = products.map((product) => {
      const recent30DayUnits = velocity.get(product._id.toHexString()) || 0;
      const inboundQuantity = inbound.get(product._id.toHexString()) || 0;
      return {
        productId: product._id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        stock: Number(product.stock || 0),
        reorderLevel: Number(product.reorderLevel || 0),
        recent30DayUnits,
        inboundQuantity,
        suggestedQuantity: suggestedReorderAfterInbound(product.stock, product.reorderLevel, recent30DayUnits, 14, inboundQuantity),
        lastBaseCost: Number(product.cost || 0),
        lastSupplierId: product.lastSupplierId || null,
        lastSupplierName: product.lastSupplierName || "",
      };
    }).filter((suggestion) => suggestion.suggestedQuantity > 0);
    return ok(serialise({
      orders: orders.map((order) => ({ ...order, isOverdue: ["APPROVED", "PARTIALLY_RECEIVED"].includes(String(order.status)) && documentDateKey(order.expectedDate) < dateKeyInTimeZone(new Date(), String(order.timeZone || business.timeZone)) })),
      products,
      locations,
      reorderSuggestions,
      business: { currency: business.currency, taxName: business.taxName, taxRate: business.taxRate, taxMode: business.taxMode, locale: business.locale, timeZone: business.timeZone },
    }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  try {
    const input = purchaseOrderInputSchema.safeParse(body.value);
    if (!input.success) return fail("Check the purchase order.", 422, input.error.flatten().fieldErrors);
    if (!ObjectId.isValid(input.data.supplierId) || !ObjectId.isValid(input.data.locationId) || input.data.items.some((item) => !ObjectId.isValid(item.productId))) return fail("A supplier, location or product reference is invalid.", 422);
    const db = await getDb();
    const existing = await db.collection("purchaseOrders").findOne({ clientRequestId: input.data.clientRequestId });
    if (existing) return ok(serialise(existing));
    const productIds = input.data.items.map((item) => new ObjectId(item.productId));
    const [supplier, location, products, settings] = await Promise.all([
      db.collection("suppliers").findOne({ _id: new ObjectId(input.data.supplierId), active: { $ne: false } }),
      db.collection("locations").findOne({ _id: new ObjectId(input.data.locationId), active: { $ne: false } }),
      db.collection("products").find({ _id: { $in: productIds }, active: { $ne: false } }).toArray(),
      db.collection("settings").findOne({ key: "business" }),
    ]);
    if (!supplier) return fail("Choose an active supplier.", 422);
    if (!location) return fail("Choose an active receiving location.", 422);
    if (products.length !== productIds.length) return fail("One or more products are archived or unavailable.", 409);
    const business = normaliseBusinessSettings(settings);
    if (documentDateKey(input.data.expectedDate) < dateKeyInTimeZone(new Date(), business.timeZone)) return fail("The expected delivery date cannot be in the past.", 422);
    const exchange = await readExchangeRate(db, business.currency, String(supplier.currency));
    if (!exchange) return fail(`Configure an active ${business.currency}/${supplier.currency} exchange rate before creating this order.`, 409);
    const productMap = new Map(products.map((product) => [product._id.toHexString(), product]));
    const items = input.data.items.map((line) => {
      const product = productMap.get(line.productId)!;
      const unitCost = roundCurrency(line.unitCost, String(supplier.currency));
      const lineTotal = roundCurrency(unitCost * line.quantity, String(supplier.currency));
      return {
        productId: product._id,
        sku: String(product.sku),
        productName: String(product.name),
        unit: String(product.unit),
        quantity: line.quantity,
        receivedQuantity: 0,
        unitCost,
        lineTotal,
        baseUnitCost: roundCurrency(unitCost / exchange.rate, business.currency),
        baseLineTotal: roundCurrency(lineTotal / exchange.rate, business.currency),
      };
    });
    if (items.some((item) => currencyMinorUnits(item.unitCost, String(supplier.currency)) <= 0)) return fail(`Every line needs a positive unit cost in ${supplier.currency}.`, 422);
    const subtotal = roundCurrency(items.reduce((sum, item) => sum + item.lineTotal, 0), String(supplier.currency));
    const totals = calculateTaxTotals(subtotal, 0, input.data.taxRate, input.data.taxMode, String(supplier.currency));
    if (Number(supplier.minimumOrder || 0) > totals.total) return fail(`This supplier requires a minimum order of ${supplier.currency} ${Number(supplier.minimumOrder).toFixed(2)}.`, 422);
    const now = new Date();
    const document = {
      clientRequestId: input.data.clientRequestId,
      purchaseOrderNo: makeDocumentNo("PO"),
      supplierId: supplier._id,
      supplierCode: supplier.code,
      supplierName: supplier.name,
      supplierSnapshot: { code: supplier.code, name: supplier.name, registrationNo: supplier.registrationNo || "", taxNo: supplier.taxNo || "", address: supplier.address || "", countryCode: supplier.countryCode, currency: supplier.currency, paymentTermsDays: Number(supplier.paymentTermsDays || 0), leadTimeDays: Number(supplier.leadTimeDays || 0) },
      locationId: location._id,
      locationCode: location.code,
      locationName: location.name,
      expectedDate: input.data.expectedDate,
      supplierReference: input.data.supplierReference,
      notes: input.data.notes,
      items,
      currency: String(supplier.currency),
      baseCurrency: business.currency,
      timeZone: business.timeZone,
      exchangeRate: exchange.rate,
      exchangeRateSource: exchange.source,
      exchangeRateEffectiveAt: exchange.effectiveAt,
      subtotal,
      taxRate: totals.taxRate,
      taxMode: totals.taxMode,
      tax: totals.tax,
      netAmount: totals.netSales,
      total: totals.total,
      baseTotal: roundCurrency(totals.total / exchange.rate, business.currency),
      status: "DRAFT",
      createdBy: new ObjectId(auth.session.id),
      createdByName: auth.session.fullName,
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("purchaseOrders").insertOne(document);
    await writeAudit(db, auth.session, "purchase_order.create", "purchaseOrder", result.insertedId.toHexString(), { purchaseOrderNo: document.purchaseOrderNo, supplierCode: supplier.code, total: document.total, currency: document.currency });
    return created(serialise({ _id: result.insertedId, ...document }));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return fail("This purchase request was already created. Refresh the list before trying again.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  const input = purchaseOrderActionSchema.safeParse(body.value);
  if (!input.success || !ObjectId.isValid(input.data?.id || "")) return fail("Check the purchase order action.", 422, input.success ? undefined : input.error.flatten().fieldErrors);
  const permission = input.data.action === "APPROVE" ? "purchasing.approve" as const : "purchasing.write" as const;
  const auth = await authorize(permission);
  if (auth.error) return auth.error;
  const db = await getDb();
  const orderId = new ObjectId(input.data.id);
  try {
    if (input.data.action === "APPROVE") {
      const now = new Date();
      const makerFilter = approvalRequiresDifferentMaker(auth.session.role) ? { createdBy: { $ne: new ObjectId(auth.session.id) } } : {};
      const order = await db.collection("purchaseOrders").findOneAndUpdate(
        { _id: orderId, status: "DRAFT", ...makerFilter },
        { $set: { status: "APPROVED", approvedAt: now, approvedBy: new ObjectId(auth.session.id), approvedByName: auth.session.fullName, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!order) return fail(approvalRequiresDifferentMaker(auth.session.role) ? "A different authorised user must approve a current draft." : "Only a current draft can be approved.", 409);
      await writeAudit(db, auth.session, "purchase_order.approve", "purchaseOrder", input.data.id, { purchaseOrderNo: order.purchaseOrderNo, total: order.total, currency: order.currency });
      return ok(serialise(order));
    }
    if (input.data.action === "CANCEL") {
      const now = new Date();
      const order = await db.collection("purchaseOrders").findOneAndUpdate(
        { _id: orderId, status: { $in: ["DRAFT", "APPROVED"] }, "items.receivedQuantity": { $not: { $gt: 0 } } },
        { $set: { status: "CANCELLED", cancelledAt: now, cancelledBy: new ObjectId(auth.session.id), cancellationReason: input.data.reason, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!order) return fail("An order with received stock cannot be cancelled. Receive or close the remaining quantity through a controlled adjustment.", 409);
      await writeAudit(db, auth.session, "purchase_order.cancel", "purchaseOrder", input.data.id, { purchaseOrderNo: order.purchaseOrderNo, reason: input.data.reason });
      return ok(serialise(order));
    }

    if (input.data.action !== "RECEIVE") return fail("This purchase order action is unavailable.", 422);
    const receiveInput = input.data;
    const duplicate = await db.collection("goodsReceipts").findOne({ clientRequestId: receiveInput.clientRequestId });
    if (duplicate) {
      const [order, bill] = await Promise.all([
        db.collection("purchaseOrders").findOne({ _id: duplicate.purchaseOrderId }),
        db.collection("accountsPayableBills").findOne({ goodsReceiptId: duplicate._id }),
      ]);
      return ok(serialise({ order, receipt: duplicate, bill }));
    }
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    const receiptId = new ObjectId();
    const billId = new ObjectId();
    const receiptNo = makeDocumentNo("GRN");
    const billNo = makeDocumentNo("APB");
    const journalNo = makeDocumentNo("JE");
    let result: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const order = await db.collection("purchaseOrders").findOne({ _id: orderId, status: { $in: ["APPROVED", "PARTIALLY_RECEIVED"] } }, { session: mongoSession });
        if (!order) throw new PurchaseConflictError("Only an approved order with outstanding quantities can be received.");
        const orderTimeZone = String(order.timeZone || "UTC");
        const receivedDay = documentDateKey(receiveInput.receivedAt);
        const invoiceDay = documentDateKey(receiveInput.invoiceDate);
        const orderDay = dateKeyInTimeZone(new Date(order.createdAt), orderTimeZone);
        const today = dateKeyInTimeZone(new Date(), orderTimeZone);
        if (receivedDay < orderDay || receivedDay > today) throw new PurchaseConflictError("Received date cannot precede the purchase order or be in the future.");
        if (invoiceDay < orderDay || invoiceDay > receivedDay) throw new PurchaseConflictError("Supplier invoice date must be between the purchase order and received dates.");
        const requested = new Map(receiveInput.lines.map((line) => [line.productId, line.quantity]));
        const selectedLines = order.items.filter((line: Record<string, unknown>) => requested.has(String(line.productId)));
        if (selectedLines.length !== requested.size) throw new PurchaseConflictError("A received product is not on this purchase order.");
        for (const line of selectedLines) {
          const quantity = requested.get(String(line.productId))!;
          const outstanding = Number(line.quantity) - Number(line.receivedQuantity || 0);
          if (quantity > outstanding) throw new PurchaseConflictError(`${line.productName} has only ${outstanding} outstanding on this order.`);
        }
        const productIds = selectedLines.map((line: Record<string, unknown>) => line.productId as ObjectId);
        const products = await db.collection("products").find({ _id: { $in: productIds }, active: { $ne: false } }, { session: mongoSession }).toArray();
        if (products.length !== productIds.length) throw new PurchaseConflictError("A product was archived before receiving. Restore it before posting the delivery.");
        const productMap = new Map(products.map((product) => [product._id.toHexString(), product]));
        const taxFactor = Number(order.taxRate || 0) / 100;
        let receiptLines = selectedLines.map((line: Record<string, unknown>) => {
          const quantity = requested.get(String(line.productId))!;
          const lineTotal = roundCurrency(Number(line.unitCost) * quantity, String(order.currency));
          const netLineTotal = order.taxMode === "INCLUSIVE" && taxFactor > 0 ? roundCurrency(lineTotal / (1 + taxFactor), String(order.currency)) : lineTotal;
          const baseInventoryValue = roundCurrency(netLineTotal / Number(order.exchangeRate), String(order.baseCurrency));
          return { ...line, orderedQuantity: Number(line.quantity), previouslyReceivedQuantity: Number(line.receivedQuantity || 0), quantity, lineTotal, netLineTotal, baseInventoryValue, baseUnitCost: roundCurrency(baseInventoryValue / quantity, String(order.baseCurrency)) };
        });
        const receiptSubtotal = roundCurrency(receiptLines.reduce((sum: number, line: Record<string, unknown>) => sum + Number(line.lineTotal), 0), String(order.currency));
        const totals = calculateTaxTotals(receiptSubtotal, 0, Number(order.taxRate || 0), order.taxMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE", String(order.currency));
        const baseTotal = roundCurrency(totals.total / Number(order.exchangeRate), String(order.baseCurrency));
        const targetBaseInventoryValue = roundCurrency(totals.netSales / Number(order.exchangeRate), String(order.baseCurrency));
        const lineBaseInventoryValue = roundCurrency(receiptLines.reduce((sum: number, line: Record<string, unknown>) => sum + Number(line.baseInventoryValue), 0), String(order.baseCurrency));
        const allocationDifference = roundCurrency(targetBaseInventoryValue - lineBaseInventoryValue, String(order.baseCurrency));
        if (allocationDifference && receiptLines.length) {
          const lastIndex = receiptLines.length - 1;
          receiptLines = receiptLines.map((line: Record<string, unknown>, index: number) => index === lastIndex ? { ...line, baseInventoryValue: roundCurrency(Number(line.baseInventoryValue) + allocationDifference, String(order.baseCurrency)), baseUnitCost: roundCurrency((Number(line.baseInventoryValue) + allocationDifference) / Number(line.quantity), String(order.baseCurrency)) } : line);
        }
        const baseInventoryValue = targetBaseInventoryValue;
        const baseTax = roundCurrency(Math.max(0, baseTotal - baseInventoryValue), String(order.baseCurrency));
        const transactionDate = receiveInput.receivedAt;
        const postedAt = new Date();
        for (const line of receiptLines) {
          const product = productMap.get(String(line.productId))!;
          const oldStock = Number(product.stock || 0);
          const newStock = oldStock + Number(line.quantity);
          const weightedCost = weightedAverageInventoryCost(oldStock, product.cost, line.quantity, line.baseInventoryValue, String(order.baseCurrency));
          const updated = await db.collection("products").updateOne(
            { _id: product._id, active: { $ne: false }, stock: oldStock },
            { $set: { stock: newStock, cost: weightedCost, lastPurchaseCost: line.baseUnitCost, lastSupplierId: order.supplierId, lastSupplierName: order.supplierName, updatedAt: postedAt } },
            { session: mongoSession },
          );
          if (!updated.modifiedCount) throw new PurchaseConflictError(`${line.productName} stock changed during receiving. Reload and post the delivery again.`);
          await db.collection("stockMovements").insertOne({
            productId: product._id, sku: line.sku, productName: line.productName, quantity: line.quantity,
            type: "PURCHASE_RECEIPT", reason: receiptNo, referenceId: receiptId, referenceNo: receiptNo,
            purchaseOrderId: order._id, purchaseOrderNo: order.purchaseOrderNo, supplierId: order.supplierId, supplierName: order.supplierName,
            unitCost: line.baseUnitCost, createdBy: new ObjectId(auth.session.id), movementDate: transactionDate, createdAt: postedAt,
          }, { session: mongoSession });
        }
        const newItems = order.items.map((line: Record<string, unknown>) => ({ ...line, receivedQuantity: Number(line.receivedQuantity || 0) + (requested.get(String(line.productId)) || 0) }));
        const fullyReceived = newItems.every((line: Record<string, unknown>) => Number(line.receivedQuantity) >= Number(line.quantity));
        const updatedOrder = await db.collection("purchaseOrders").findOneAndUpdate(
          { _id: order._id, status: order.status, updatedAt: order.updatedAt },
          { $set: { items: newItems, receiptIds: [...(Array.isArray(order.receiptIds) ? order.receiptIds : []), receiptId], status: fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED", ...(fullyReceived ? { receivedAt: transactionDate } : {}), updatedAt: postedAt } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!updatedOrder) throw new PurchaseConflictError("The purchase order changed during receiving. Reload before trying again.");
        const supplierInvoiceNoNormalized = receiveInput.supplierInvoiceNo.trim().toUpperCase();
        const dueDate = new Date(receiveInput.invoiceDate.getTime() + Number(order.supplierSnapshot?.paymentTermsDays || 0) * 86_400_000);
        const receipt = {
          _id: receiptId, clientRequestId: receiveInput.clientRequestId, receiptNo, purchaseOrderId: order._id, purchaseOrderNo: order.purchaseOrderNo,
          supplierId: order.supplierId, supplierCode: order.supplierCode, supplierName: order.supplierName,
          locationId: order.locationId, locationCode: order.locationCode, locationName: order.locationName,
          supplierInvoiceNo: receiveInput.supplierInvoiceNo, items: receiptLines, currency: order.currency, baseCurrency: order.baseCurrency,
          exchangeRate: order.exchangeRate, exchangeRateSource: order.exchangeRateSource, subtotal: receiptSubtotal, taxRate: totals.taxRate,
          taxMode: totals.taxMode, tax: totals.tax, total: totals.total, baseInventoryValue, baseTax, baseTotal,
          notes: receiveInput.notes, receivedAt: transactionDate, receivedBy: new ObjectId(auth.session.id), receivedByName: auth.session.fullName, createdAt: postedAt,
        };
        const bill = {
          _id: billId, billNo, supplierId: order.supplierId, supplierCode: order.supplierCode, supplierName: order.supplierName,
          supplierInvoiceNo: receiveInput.supplierInvoiceNo, supplierInvoiceNoNormalized, purchaseOrderId: order._id, purchaseOrderNo: order.purchaseOrderNo,
          goodsReceiptId: receiptId, receiptNo, invoiceDate: receiveInput.invoiceDate, dueDate,
          currency: order.currency, baseCurrency: order.baseCurrency, timeZone: order.timeZone || "UTC", exchangeRate: order.exchangeRate, total: totals.total, baseTotal,
          paidAmount: 0, balance: totals.total, baseSettledAmount: 0, baseBalance: baseTotal, status: "OPEN",
          createdBy: new ObjectId(auth.session.id), createdAt: postedAt, updatedAt: postedAt,
        };
        await ensureProcurementAccounts(db, new ObjectId(auth.session.id), mongoSession);
        await db.collection("goodsReceipts").insertOne(receipt, { session: mongoSession });
        await db.collection("accountsPayableBills").insertOne(bill, { session: mongoSession });
        const journalLines = [
          { accountCode: "1200", accountName: "Inventory", debit: baseInventoryValue, credit: 0 },
          ...(baseTax > 0 ? [{ accountCode: "1300", accountName: "Input tax recoverable", debit: baseTax, credit: 0 }] : []),
          { accountCode: "2000", accountName: "Accounts payable", debit: 0, credit: baseTotal },
        ];
        await db.collection("journalEntries").insertOne({
          entryNo: journalNo, date: transactionDate, memo: `Goods receipt ${receiptNo} · ${order.supplierName}`, reference: receiveInput.supplierInvoiceNo,
          source: "PURCHASE_RECEIPT", sourceId: receiptId, status: "POSTED", lines: journalLines,
          totalDebit: baseTotal, totalCredit: baseTotal, createdBy: new ObjectId(auth.session.id), createdAt: postedAt,
        }, { session: mongoSession });
        const lateDays = Math.max(0, Math.round((new Date(`${receivedDay}T00:00:00.000Z`).getTime() - new Date(`${documentDateKey(order.expectedDate)}T00:00:00.000Z`).getTime()) / 86_400_000));
        await db.collection("suppliers").updateOne(
          { _id: order.supplierId },
          { $inc: { receiptCount: 1, onTimeReceiptCount: lateDays === 0 ? 1 : 0, lateDaysTotal: lateDays, receivedBaseValue: baseTotal }, $set: { lastReceiptAt: transactionDate, updatedAt: postedAt } },
          { session: mongoSession },
        );
        await writeAudit(db, auth.session, "purchase_order.receive", "purchaseOrder", receiveInput.id, { purchaseOrderNo: order.purchaseOrderNo, receiptNo, billNo, supplierInvoiceNo: receiveInput.supplierInvoiceNo, baseTotal, fullyReceived }, mongoSession);
        result = { order: updatedOrder, receipt, bill };
      });
    } finally { await mongoSession.endSession(); }
    return ok(serialise(result));
  } catch (error) {
    if (error instanceof PurchaseConflictError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("This delivery or supplier invoice was already posted. Refresh before trying again.", 409);
    return publicError(error);
  }
}
