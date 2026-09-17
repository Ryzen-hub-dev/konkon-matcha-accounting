import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import {
  addInventoryBatchQuantity,
  batchExpiryStatus,
  BatchInventoryError,
  ensureInventoryDispositionAccount,
  forecastBatchFreshness,
  inventoryBatchActionSchema,
  lotKey,
  normaliseLotNo,
  openingTotalsByLocation,
} from "@/lib/inventory-batches";
import { assessInventoryAdjustment, writeOperationalReview } from "@/lib/operational-reviews";
import { roundCurrency } from "@/lib/international";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await authorize("inventory.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const traceLot = url.searchParams.get("lot")?.trim() || "";
    if (traceLot) {
      if (traceLot.length > 80) return fail("The lot number is too long.", 422);
      const traceProductId = url.searchParams.get("productId")?.trim() || "";
      if (!ObjectId.isValid(traceProductId)) return fail("Choose a valid product to trace this lot.", 422);
      const productId = new ObjectId(traceProductId);
      const normalizedLotKey = lotKey(traceLot);
      const [batches, receipts, sales, refunds, transfers, events] = await Promise.all([
        db.collection("inventoryBatches").find({ productId, lotKey: normalizedLotKey }).sort({ createdAt: 1 }).limit(500).toArray(),
        db.collection("goodsReceipts").find({ items: { $elemMatch: { productId, lotKey: normalizedLotKey } } }, { projection: { receiptNo: 1, purchaseOrderNo: 1, supplierName: 1, locationCode: 1, receivedAt: 1, items: 1 } }).sort({ receivedAt: -1 }).limit(500).toArray(),
        db.collection("sales").find({ items: { $elemMatch: { productId, "batchAllocations.lotKey": normalizedLotKey } } }, { projection: { receiptNo: 1, status: 1, locationCode: 1, createdAt: 1, items: 1 } }).sort({ createdAt: -1 }).limit(500).toArray(),
        db.collection("refunds").find({ items: { $elemMatch: { productId, "batchAllocations.lotKey": normalizedLotKey } } }, { projection: { refundNo: 1, receiptNo: 1, createdAt: 1, items: 1 } }).sort({ createdAt: -1 }).limit(500).toArray(),
        db.collection("stockTransfers").find({ items: { $elemMatch: { productId, "batchAllocations.lotKey": normalizedLotKey } } }, { projection: { transferNo: 1, status: 1, sourceLocationCode: 1, destinationLocationCode: 1, dispatchedAt: 1, receivedAt: 1, items: 1 } }).sort({ dispatchedAt: -1 }).limit(500).toArray(),
        db.collection("inventoryBatchEvents").find({ productId, lotKey: normalizedLotKey }, { projection: { eventNo: 1, action: 1, disposition: 1, locationCode: 1, quantity: 1, reason: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(500).toArray(),
      ]);
      const matchingItems = (items: unknown) => Array.isArray(items) ? items.filter((item) => String(item.productId) === traceProductId && (Array.isArray(item.batchAllocations)
        ? item.batchAllocations.some((allocation: Record<string, unknown>) => String(allocation.lotKey) === normalizedLotKey)
        : String(item.lotKey || "") === normalizedLotKey)) : [];
      return ok(serialise({
        lotNo: traceLot,
        batches,
        receipts: receipts.map((record) => ({ ...record, items: matchingItems(record.items) })),
        sales: sales.map((record) => ({ ...record, items: matchingItems(record.items) })),
        refunds: refunds.map((record) => ({ ...record, items: matchingItems(record.items) })),
        transfers: transfers.map((record) => ({ ...record, items: matchingItems(record.items) })),
        events,
      }));
    }
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const [products, locations, balances, batches, settings, salesVelocity] = await Promise.all([
      db.collection("products").find({ active: { $ne: false } }).sort({ category: 1, name: 1 }).limit(500).toArray(),
      db.collection("locations").find({ active: { $ne: false } }).sort({ type: 1, code: 1 }).limit(300).toArray(),
      db.collection("inventoryBalances").find({}).sort({ locationCode: 1, productName: 1 }).limit(50_000).toArray(),
      db.collection("inventoryBatches").find({}).sort({ expiryDate: 1, productName: 1, locationCode: 1 }).limit(50_000).toArray(),
      db.collection("settings").findOne({ key: "business" }),
      db.collection("sales").aggregate([
        { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] } } },
        { $unwind: "$items" },
        { $project: { productId: "$items.productId", locationId: 1, units: { $max: [0, { $subtract: ["$items.quantity", { $ifNull: ["$items.refundedQuantity", 0] }] }] } } },
        { $group: { _id: { productId: "$productId", locationId: "$locationId" }, units: { $sum: "$units" } } },
      ]).toArray(),
    ]);
    const business = normaliseBusinessSettings(settings);
    const today = dateKeyInTimeZone(new Date(), business.timeZone);
    const productMap = new Map(products.map((product) => [String(product._id), product]));
    const locationMap = new Map(locations.map((location) => [String(location._id), location]));
    const forecast = forecastBatchFreshness(
      batches.filter((batch) => Number(batch.quantity || 0) > 0).map((batch) => ({ id: String(batch._id), productId: String(batch.productId), locationId: String(batch.locationId), quantity: Number(batch.quantity || 0), expiryDate: String(batch.expiryDate) })),
      salesVelocity.filter((row) => row._id?.productId && row._id?.locationId).map((row) => ({ productId: String(row._id.productId), locationId: String(row._id.locationId), units: Number(row.units || 0) })),
      today,
    );
    const balancesByProduct = new Map<string, typeof balances>();
    for (const balance of balances) {
      const productId = String(balance.productId);
      const current = balancesByProduct.get(productId) || [];
      current.push(balance);
      balancesByProduct.set(productId, current);
    }
    const inventory = products.map((product) => ({
      ...product,
      batchTracked: product.batchTracked === true,
      expiryWarningDays: Number(product.expiryWarningDays || 30),
      locationTracked: balancesByProduct.has(String(product._id)),
      locationBalances: balancesByProduct.get(String(product._id)) || [],
    }));
    const allBatches = batches.map((batch) => {
      const projection = forecast.get(String(batch._id));
      const suggestionLocation = projection?.suggestedLocationId ? locationMap.get(projection.suggestedLocationId) : null;
      return {
        ...batch,
        ...(Number(batch.quantity || 0) > 0 ? batchExpiryStatus(String(batch.expiryDate), today, Number(productMap.get(String(batch.productId))?.expiryWarningDays || 30)) : { daysRemaining: null, status: "DEPLETED" as const }),
        ...(projection ? {
          dailyDemand: projection.dailyDemand,
          projectedAtRisk: projection.projectedAtRisk,
          forecastRisk: projection.forecastRisk,
          predictedDepletionDate: projection.predictedDepletionDate,
          ...(suggestionLocation ? { transferSuggestion: { locationId: suggestionLocation._id, locationCode: suggestionLocation.code, locationName: suggestionLocation.name, quantity: projection.suggestedTransferQuantity } } : {}),
        } : { dailyDemand: 0, projectedAtRisk: 0, forecastRisk: "LOW", predictedDepletionDate: null }),
      };
    });
    return ok(serialise({
      products: inventory,
      locations,
      batches: allBatches,
      today,
      counts: {
        trackedProducts: inventory.filter((product) => product.batchTracked === true).length,
        liveBatches: batches.filter((batch) => Number(batch.quantity || 0) > 0).length,
        expiring: allBatches.filter((batch) => batch.status === "EXPIRING").length,
        expired: allBatches.filter((batch) => batch.status === "EXPIRED").length,
        atRiskUnits: allBatches.reduce((sum, batch) => sum + Number(batch.projectedAtRisk || 0), 0),
      },
    }));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("inventory.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return fail("The request body must be valid JSON.", 400); }
    const input = inventoryBatchActionSchema.safeParse(body);
    if (!input.success) return fail("Check the batch inventory details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const duplicateCollection = input.data.action === "ACTIVATE" ? "inventoryBatchActivations" : "inventoryBatchEvents";
    const duplicate = await db.collection(duplicateCollection).findOne({ clientRequestId: input.data.clientRequestId });
    if (duplicate) return ok(serialise(duplicate));
    const settings = await db.collection("settings").findOne({ key: "business" });
    const business = normaliseBusinessSettings(settings);
    const today = dateKeyInTimeZone(new Date(), business.timeZone);
    const actorId = new ObjectId(auth.session.id);
    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let result: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const now = new Date();
        if (input.data.action === "ACTIVATE") {
          const productId = new ObjectId(input.data.productId);
          const product = await db.collection("products").findOne({ _id: productId, active: { $ne: false } }, { session: mongoSession });
          if (!product) throw new BatchInventoryError("The product is archived or no longer available.");
          if (product.batchTracked) throw new BatchInventoryError("This product already uses batch and expiry tracking.");
          const balances = await db.collection("inventoryBalances").find({ productId }, { session: mongoSession }).toArray();
          if (!balances.length) throw new BatchInventoryError("Activate location inventory for this product before enabling batch tracking.");
          const inTransit = await db.collection("stockTransfers").findOne({ status: "IN_TRANSIT", "items.productId": productId }, { projection: { transferNo: 1 }, session: mongoSession });
          if (inTransit) throw new BatchInventoryError(`Receive or cancel ${String(inTransit.transferNo)} before enabling batch tracking.`);
          const locationIds = [...new Set(input.data.openings.map((opening) => opening.locationId))].map((id) => new ObjectId(id));
          const locations = locationIds.length ? await db.collection("locations").find({ _id: { $in: locationIds }, active: { $ne: false } }, { session: mongoSession }).toArray() : [];
          if (locations.length !== locationIds.length) throw new BatchInventoryError("One or more opening batch locations are inactive.");
          const balanceMap = new Map(balances.map((balance) => [String(balance.locationId), balance]));
          const locationMap = new Map(locations.map((location) => [String(location._id), location]));
          const totals = openingTotalsByLocation(input.data.openings);
          for (const opening of input.data.openings) {
            if (!balanceMap.has(opening.locationId)) throw new BatchInventoryError("An opening batch location is not allocated to this product.");
          }
          for (const balance of balances) {
            const expected = Number(balance.quantity || 0);
            const actual = totals.get(String(balance.locationId)) || 0;
            if (actual !== expected) throw new BatchInventoryError(`Opening batches at ${String(balance.locationName)} must total exactly ${expected} units.`);
          }
          if ([...totals.values()].reduce((sum, quantity) => sum + quantity, 0) !== Number(product.stock || 0)) {
            throw new BatchInventoryError(`Opening batches must total exactly ${Number(product.stock || 0)} company units.`);
          }
          const batchDocuments = input.data.openings.map((opening) => {
            const location = locationMap.get(opening.locationId)!;
            return {
              _id: new ObjectId(), productId, sku: String(product.sku), productName: String(product.name),
              locationId: location._id, locationCode: String(location.code), locationName: String(location.name),
              lotNo: normaliseLotNo(opening.lotNo), lotKey: lotKey(opening.lotNo), expiryDate: opening.expiryDate,
              quantity: opening.quantity, version: 0, sourceType: "OPENING", receivedAt: now,
              createdBy: actorId, createdAt: now, updatedAt: now,
            };
          });
          if (batchDocuments.length) await db.collection("inventoryBatches").insertMany(batchDocuments, { session: mongoSession });
          const activated = await db.collection("products").updateOne(
            { _id: productId, batchTracked: { $ne: true }, stock: Number(product.stock || 0) },
            { $set: { batchTracked: true, expiryWarningDays: input.data.expiryWarningDays, batchTrackingActivatedAt: now, batchTrackingActivatedBy: actorId, updatedAt: now } },
            { session: mongoSession },
          );
          if (!activated.modifiedCount) throw new BatchInventoryError("The product changed while batch tracking was being enabled. Refresh and try again.");
          const activation = {
            _id: new ObjectId(), clientRequestId: input.data.clientRequestId, productId, sku: product.sku, productName: product.name,
            totalStock: Number(product.stock || 0), expiryWarningDays: input.data.expiryWarningDays,
            openings: batchDocuments.map((batch) => ({ batchId: batch._id, locationId: batch.locationId, locationCode: batch.locationCode, locationName: batch.locationName, lotNo: batch.lotNo, expiryDate: batch.expiryDate, quantity: batch.quantity })),
            activatedBy: actorId, activatedByName: auth.session.fullName, createdAt: now,
          };
          await db.collection("inventoryBatchActivations").insertOne(activation, { session: mongoSession });
          await writeAudit(db, auth.session, "inventory.batch_activate", "product", input.data.productId, { sku: product.sku, totalStock: product.stock, expiryWarningDays: input.data.expiryWarningDays, batchCount: batchDocuments.length }, mongoSession);
          result = activation;
          return;
        }

        if (input.data.action === "ADD") {
          const productId = new ObjectId(input.data.productId);
          const locationId = new ObjectId(input.data.locationId);
          const [product, location, trackedBalance, selectedBalance] = await Promise.all([
            db.collection("products").findOne({ _id: productId, active: { $ne: false }, batchTracked: true }, { session: mongoSession }),
            db.collection("locations").findOne({ _id: locationId, active: { $ne: false } }, { session: mongoSession }),
            db.collection("inventoryBalances").findOne({ productId }, { projection: { _id: 1 }, session: mongoSession }),
            db.collection("inventoryBalances").findOne({ productId, locationId }, { session: mongoSession }),
          ]);
          if (!product) throw new BatchInventoryError("Choose an active batch-tracked product.");
          if (!location || !trackedBalance) throw new BatchInventoryError("Choose an active location for this location-tracked product.");
          const movementNo = makeDocumentNo("BAT");
          await addInventoryBatchQuantity(db, {
            productId, sku: String(product.sku), productName: String(product.name), locationId,
            locationCode: String(location.code), locationName: String(location.name),
            allocation: { lotNo: input.data.lotNo, lotKey: lotKey(input.data.lotNo), expiryDate: input.data.expiryDate, quantity: input.data.quantity },
            actorId, now,
          }, mongoSession);
          await db.collection("inventoryBalances").updateOne(
            { productId, locationId },
            {
              $inc: { quantity: input.data.quantity },
              $set: { sku: product.sku, productName: product.name, locationCode: location.code, locationName: location.name, updatedAt: now },
              $setOnInsert: { _id: new ObjectId(), createdBy: actorId, createdAt: now },
            },
            { upsert: !selectedBalance, session: mongoSession },
          );
          await db.collection("products").updateOne({ _id: productId }, { $inc: { stock: input.data.quantity }, $set: { updatedAt: now } }, { session: mongoSession });
          const event = {
            _id: new ObjectId(), eventNo: movementNo, clientRequestId: input.data.clientRequestId, action: "ADD", productId,
            sku: product.sku, productName: product.name, locationId, locationCode: location.code, locationName: location.name,
            lotNo: normaliseLotNo(input.data.lotNo), lotKey: lotKey(input.data.lotNo), expiryDate: input.data.expiryDate, quantity: input.data.quantity,
            reason: input.data.reason, createdBy: actorId, createdByName: auth.session.fullName, createdAt: now,
          };
          await db.collection("inventoryBatchEvents").insertOne(event, { session: mongoSession });
          await db.collection("stockMovements").insertOne({
            productId, sku: product.sku, productName: product.name, quantity: input.data.quantity, type: "BATCH_ADJUSTMENT", reason: input.data.reason,
            referenceId: event._id, referenceNo: movementNo, locationId, locationCode: location.code, locationName: location.name,
            lotNo: event.lotNo, expiryDate: event.expiryDate, createdBy: actorId, createdAt: now,
          }, { session: mongoSession });
          await writeAudit(db, auth.session, "inventory.batch_add", "product", input.data.productId, { movementNo, locationId: input.data.locationId, lotNo: event.lotNo, expiryDate: event.expiryDate, quantity: input.data.quantity, reason: input.data.reason }, mongoSession);
          result = event;
          return;
        }

        if (input.data.action === "DISPOSE") {
          const batchId = new ObjectId(input.data.batchId);
          const batch = await db.collection("inventoryBatches").findOne({ _id: batchId, version: input.data.version, quantity: { $gte: input.data.quantity } }, { session: mongoSession });
          if (!batch) throw new BatchInventoryError("This batch changed or no longer has enough units to dispose. Refresh and try again.");
          const product = await db.collection("products").findOne({ _id: batch.productId, active: { $ne: false }, batchTracked: true }, { session: mongoSession });
          if (!product) throw new BatchInventoryError("The batch product is archived or no longer available.");
          const updatedBatch = await db.collection("inventoryBatches").updateOne(
            { _id: batchId, version: input.data.version, quantity: { $gte: input.data.quantity } },
            { $inc: { quantity: -input.data.quantity, version: 1 }, $set: { updatedAt: now } },
            { session: mongoSession },
          );
          const local = await db.collection("inventoryBalances").updateOne(
            { productId: batch.productId, locationId: batch.locationId, quantity: { $gte: input.data.quantity } },
            { $inc: { quantity: -input.data.quantity }, $set: { updatedAt: now } },
            { session: mongoSession },
          );
          const global = await db.collection("products").updateOne(
            { _id: batch.productId, batchTracked: true, stock: { $gte: input.data.quantity } },
            { $inc: { stock: -input.data.quantity }, $set: { updatedAt: now } },
            { session: mongoSession },
          );
          if (!updatedBatch.modifiedCount || !local.modifiedCount || !global.modifiedCount) throw new BatchInventoryError("The batch or product balance changed during disposal. Refresh and try again.");
          const eventNo = makeDocumentNo("DSP");
          const inventoryValue = roundCurrency(Number(product.cost || 0) * input.data.quantity, business.currency);
          const event = {
            _id: new ObjectId(), eventNo, clientRequestId: input.data.clientRequestId, action: "DISPOSE", batchId,
            productId: batch.productId, sku: batch.sku, productName: batch.productName,
            locationId: batch.locationId, locationCode: batch.locationCode, locationName: batch.locationName,
            lotNo: batch.lotNo, lotKey: batch.lotKey, expiryDate: batch.expiryDate, quantity: -input.data.quantity,
            disposition: input.data.disposition, reason: input.data.reason, unitCost: Number(product.cost || 0), inventoryValue, currency: business.currency,
            createdBy: actorId, createdByName: auth.session.fullName, createdAt: now,
          };
          await db.collection("inventoryBatchEvents").insertOne(event, { session: mongoSession });
          await db.collection("stockMovements").insertOne({
            productId: batch.productId, sku: batch.sku, productName: batch.productName, quantity: -input.data.quantity,
            type: "BATCH_DISPOSAL", reason: input.data.reason, disposition: input.data.disposition,
            referenceId: event._id, referenceNo: eventNo, locationId: batch.locationId, locationCode: batch.locationCode, locationName: batch.locationName,
            batchId, lotNo: batch.lotNo, expiryDate: batch.expiryDate, unitCost: event.unitCost, inventoryValue,
            createdBy: actorId, createdAt: now,
          }, { session: mongoSession });
          if (inventoryValue > 0) {
            await ensureInventoryDispositionAccount(db, actorId, mongoSession);
            const entryNo = makeDocumentNo("JE");
            await db.collection("journalEntries").insertOne({
              entryNo, date: now, memo: `Inventory write-off ${eventNo} · ${String(batch.productName)} lot ${String(batch.lotNo)}`,
              reference: eventNo, source: "INVENTORY_DISPOSAL", status: "POSTED",
              locationId: batch.locationId,
              lines: [
                { accountCode: "5100", accountName: "Inventory write-off", debit: inventoryValue, credit: 0 },
                { accountCode: "1200", accountName: "Inventory", debit: 0, credit: inventoryValue },
              ],
              totalDebit: inventoryValue, totalCredit: inventoryValue, currency: business.currency,
              createdBy: actorId, createdAt: now,
            }, { session: mongoSession });
            await db.collection("inventoryBatchEvents").updateOne({ _id: event._id }, { $set: { journalEntryNo: entryNo } }, { session: mongoSession });
            Object.assign(event, { journalEntryNo: entryNo });
          }
          await writeOperationalReview(db, assessInventoryAdjustment({ currentStock: Number(batch.quantity || 0), adjustment: -input.data.quantity }), {
            sourceType: "stockMovement", sourceId: event._id.toHexString(), sourceNo: eventNo, sourceHref: "/batches", occurredAt: now, actor: auth.session, currency: business.currency,
          }, mongoSession);
          await writeAudit(db, auth.session, "inventory.batch_dispose", "inventoryBatch", input.data.batchId, { eventNo, quantity: input.data.quantity, disposition: input.data.disposition, reason: input.data.reason, inventoryValue, currency: business.currency }, mongoSession);
          result = event;
          return;
        }

        const batchId = new ObjectId(input.data.batchId);
        const batch = await db.collection("inventoryBatches").findOne({ _id: batchId, version: input.data.version }, { session: mongoSession });
        if (!batch) throw new BatchInventoryError("This batch changed while you were counting it. Refresh and try again.");
        const difference = input.data.countedQuantity - Number(batch.quantity || 0);
        const eventNo = makeDocumentNo("BTC");
        const updated = await db.collection("inventoryBatches").updateOne(
          { _id: batchId, version: input.data.version, quantity: Number(batch.quantity || 0) },
          { $set: { quantity: input.data.countedQuantity, updatedAt: now }, $inc: { version: 1 } },
          { session: mongoSession },
        );
        if (!updated.modifiedCount) throw new BatchInventoryError("This batch changed while you were counting it. Refresh and try again.");
        if (difference) {
          const local = await db.collection("inventoryBalances").updateOne(
            { productId: batch.productId, locationId: batch.locationId, $expr: { $gte: [{ $add: ["$quantity", difference] }, 0] } },
            { $inc: { quantity: difference }, $set: { updatedAt: now } },
            { session: mongoSession },
          );
          const global = await db.collection("products").updateOne(
            { _id: batch.productId, batchTracked: true, $expr: { $gte: [{ $add: ["$stock", difference] }, 0] } },
            { $inc: { stock: difference }, $set: { updatedAt: now } },
            { session: mongoSession },
          );
          if (!local.modifiedCount || !global.modifiedCount) throw new BatchInventoryError("The product balance changed while the batch count was being posted.");
        }
        const event = {
          _id: new ObjectId(), eventNo, clientRequestId: input.data.clientRequestId, action: "COUNT", batchId,
          productId: batch.productId, sku: batch.sku, productName: batch.productName,
          locationId: batch.locationId, locationCode: batch.locationCode, locationName: batch.locationName,
          lotNo: batch.lotNo, lotKey: batch.lotKey, expiryDate: batch.expiryDate, bookQuantity: Number(batch.quantity || 0),
          countedQuantity: input.data.countedQuantity, quantity: difference, reason: input.data.reason,
          createdBy: actorId, createdByName: auth.session.fullName, createdAt: now,
        };
        await db.collection("inventoryBatchEvents").insertOne(event, { session: mongoSession });
        if (difference) await db.collection("stockMovements").insertOne({
          productId: batch.productId, sku: batch.sku, productName: batch.productName, quantity: difference,
          type: "BATCH_STOCKTAKE", reason: input.data.reason, referenceId: event._id, referenceNo: eventNo,
          locationId: batch.locationId, locationCode: batch.locationCode, locationName: batch.locationName,
          batchId, lotNo: batch.lotNo, expiryDate: batch.expiryDate, bookStock: batch.quantity, countedStock: input.data.countedQuantity,
          createdBy: actorId, createdAt: now,
        }, { session: mongoSession });
        await writeOperationalReview(db, assessInventoryAdjustment({ currentStock: Number(batch.quantity || 0), adjustment: difference }), {
          sourceType: "stockMovement", sourceId: event._id.toHexString(), sourceNo: eventNo, sourceHref: "/batches", occurredAt: now, actor: auth.session,
        }, mongoSession);
        await writeAudit(db, auth.session, "inventory.batch_count", "inventoryBatch", input.data.batchId, { eventNo, bookQuantity: batch.quantity, countedQuantity: input.data.countedQuantity, difference, reason: input.data.reason }, mongoSession);
        result = event;
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise(result));
  } catch (error) {
    if (error instanceof BatchInventoryError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("This batch request was already posted or conflicts with an existing lot. Refresh and try again.", 409);
    return publicError(error);
  }
}
