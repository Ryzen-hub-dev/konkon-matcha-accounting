import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { allocationTotal, stockTransferActionSchema, stockTransferPostSchema, transferUnitTotal } from "@/lib/inventory-locations";
import { ensureHeadquarters } from "@/lib/locations";
import { addInventoryBatchQuantity, BatchInventoryError, consumeInventoryBatches, type InventoryBatchAllocation } from "@/lib/inventory-batches";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { dateKeyInTimeZone } from "@/lib/dates";

export const runtime = "nodejs";

class TransferConflictError extends Error {}

export async function GET() {
  const auth = await authorize("inventory.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    await ensureHeadquarters(db);
    const [locations, products, balances, transfers] = await Promise.all([
      db.collection("locations").find({ active: { $ne: false } }).sort({ type: 1, code: 1 }).limit(100).toArray(),
      db.collection("products").find({ active: { $ne: false } }).sort({ category: 1, name: 1 }).limit(500).toArray(),
      db.collection("inventoryBalances").find({}).sort({ locationCode: 1, sku: 1 }).limit(50_000).toArray(),
      db.collection("stockTransfers").find({}).sort({ dispatchedAt: -1 }).limit(200).toArray(),
    ]);
    const balancesByProduct = new Map<string, typeof balances>();
    for (const balance of balances) {
      const key = String(balance.productId);
      const current = balancesByProduct.get(key) || [];
      current.push(balance);
      balancesByProduct.set(key, current);
    }
    const inventory = products.map((product) => {
      const productBalances = balancesByProduct.get(String(product._id)) || [];
      return {
        ...product,
        locationTracked: productBalances.length > 0,
        allocatedStock: productBalances.reduce((sum, balance) => sum + Number(balance.quantity || 0), 0),
        locationBalances: productBalances,
      };
    });
    return ok(serialise({ locations, products: inventory, transfers }));
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
    const input = stockTransferPostSchema.safeParse(body);
    if (!input.success) return fail("Check the inventory allocation or transfer.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const actorId = new ObjectId(auth.session.id);
    if (input.data.action === "ALLOCATE") {
      const existing = await db.collection("inventoryActivations").findOne({ clientRequestId: input.data.clientRequestId });
      if (existing) return ok(serialise(existing));
    } else {
      const existing = await db.collection("stockTransfers").findOne({ clientRequestId: input.data.clientRequestId });
      if (existing) return ok(serialise(existing));
    }

    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let result: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const now = new Date();
        if (input.data.action === "ALLOCATE") {
          const productId = new ObjectId(input.data.productId);
          const product = await db.collection("products").findOne({ _id: productId, active: { $ne: false } }, { session: mongoSession });
          if (!product) throw new TransferConflictError("The product is archived or no longer available.");
          const existingBalance = await db.collection("inventoryBalances").findOne({ productId }, { session: mongoSession });
          if (existingBalance) throw new TransferConflictError("This product already uses location inventory. Adjust or transfer its balances instead.");
          if (allocationTotal(input.data.allocations) !== Number(product.stock || 0)) {
            throw new TransferConflictError(`Allocate exactly ${Number(product.stock || 0)} units, matching the current total stock.`);
          }
          const locationIds = input.data.allocations.map((allocation) => new ObjectId(allocation.locationId));
          const locations = await db.collection("locations").find({ _id: { $in: locationIds }, active: { $ne: false } }, { session: mongoSession }).toArray();
          if (locations.length !== locationIds.length) throw new TransferConflictError("One or more allocation locations are inactive.");
          const locationMap = new Map(locations.map((location) => [String(location._id), location]));
          const balanceDocuments = input.data.allocations.map((allocation) => {
            const location = locationMap.get(allocation.locationId)!;
            return {
              _id: new ObjectId(), productId, sku: String(product.sku), productName: String(product.name),
              locationId: location._id, locationCode: String(location.code), locationName: String(location.name),
              quantity: allocation.quantity, activationRequestId: input.data.clientRequestId,
              createdBy: actorId, createdAt: now, updatedAt: now,
            };
          });
          await db.collection("inventoryBalances").insertMany(balanceDocuments, { session: mongoSession });
          const positive = balanceDocuments.filter((balance) => balance.quantity > 0);
          if (positive.length) await db.collection("stockMovements").insertMany(positive.map((balance) => ({
            productId, sku: product.sku, productName: product.name, quantity: balance.quantity,
            type: "LOCATION_OPENING", reason: "Location inventory activation", affectsGlobalStock: false,
            locationId: balance.locationId, locationCode: balance.locationCode, locationName: balance.locationName,
            createdBy: actorId, createdAt: now,
          })), { session: mongoSession });
          const activation = {
            _id: new ObjectId(), clientRequestId: input.data.clientRequestId, productId, sku: product.sku, productName: product.name,
            totalStock: Number(product.stock || 0), allocations: balanceDocuments.map((balance) => ({ locationId: balance.locationId, locationCode: balance.locationCode, locationName: balance.locationName, quantity: balance.quantity })),
            activatedBy: actorId, activatedByName: auth.session.fullName, createdAt: now,
          };
          await db.collection("inventoryActivations").insertOne(activation, { session: mongoSession });
          await writeAudit(db, auth.session, "inventory.location_activate", "product", input.data.productId, { sku: product.sku, totalStock: product.stock, allocations: activation.allocations }, mongoSession);
          result = activation;
          return;
        }

        const sourceId = new ObjectId(input.data.sourceLocationId);
        const destinationId = new ObjectId(input.data.destinationLocationId);
        const [source, destination] = await Promise.all([
          db.collection("locations").findOne({ _id: sourceId, active: { $ne: false } }, { session: mongoSession }),
          db.collection("locations").findOne({ _id: destinationId, active: { $ne: false } }, { session: mongoSession }),
        ]);
        if (!source || !destination) throw new TransferConflictError("Choose active source and destination locations.");
        const productIds = input.data.items.map((item) => new ObjectId(item.productId));
        const products = await db.collection("products").find({ _id: { $in: productIds }, active: { $ne: false } }, { session: mongoSession }).toArray();
        if (products.length !== productIds.length) throw new TransferConflictError("One or more products are archived or unavailable.");
        const trackedIds = await db.collection("inventoryBalances").distinct("productId", { productId: { $in: productIds } }, { session: mongoSession });
        if (trackedIds.length !== productIds.length) throw new TransferConflictError("Allocate every selected product to locations before transferring it.");
        const productMap = new Map(products.map((product) => [String(product._id), product]));
        const items = input.data.items.map((item) => {
          const product = productMap.get(item.productId)!;
          return { productId: product._id, sku: String(product.sku), productName: String(product.name), unit: String(product.unit), quantity: item.quantity, batchAllocations: [] as InventoryBatchAllocation[] };
        });
        for (const item of items) {
          const product = productMap.get(String(item.productId))!;
          if (product.batchTracked) {
            item.batchAllocations = await consumeInventoryBatches(db, {
              productId: item.productId, locationId: sourceId, quantity: item.quantity,
              today: dateKeyInTimeZone(now, business.timeZone), productName: item.productName, now,
            }, mongoSession);
          }
          const reserved = await db.collection("inventoryBalances").updateOne(
            { productId: item.productId, locationId: sourceId, quantity: { $gte: item.quantity } },
            { $inc: { quantity: -item.quantity }, $set: { updatedAt: now } },
            { session: mongoSession },
          );
          if (!reserved.modifiedCount) throw new TransferConflictError(`${item.productName} does not have ${item.quantity} available at ${source.name}.`);
        }
        const transferId = new ObjectId();
        const transfer = {
          _id: transferId, transferNo: makeDocumentNo("TRF"), clientRequestId: input.data.clientRequestId,
          sourceLocationId: source._id, sourceLocationCode: String(source.code), sourceLocationName: String(source.name),
          destinationLocationId: destination._id, destinationLocationCode: String(destination.code), destinationLocationName: String(destination.name),
          status: "IN_TRANSIT", note: input.data.note, items, totalUnits: transferUnitTotal(items),
          dispatchedBy: actorId, dispatchedByName: auth.session.fullName, dispatchedAt: now, version: 0, updatedAt: now,
        };
        await db.collection("stockTransfers").insertOne(transfer, { session: mongoSession });
        await db.collection("stockMovements").insertMany(items.map((item) => ({
          productId: item.productId, sku: item.sku, productName: item.productName, quantity: -item.quantity,
          type: "TRANSFER_OUT", reason: transfer.transferNo, referenceId: transferId, referenceNo: transfer.transferNo, affectsGlobalStock: false,
          locationId: source._id, locationCode: source.code, locationName: source.name,
          destinationLocationId: destination._id, destinationLocationCode: destination.code, destinationLocationName: destination.name,
          createdBy: actorId, createdAt: now,
        })), { session: mongoSession });
        await writeAudit(db, auth.session, "inventory.transfer_dispatch", "stockTransfer", transferId.toHexString(), { transferNo: transfer.transferNo, source: source.code, destination: destination.code, totalUnits: transfer.totalUnits }, mongoSession);
        result = transfer;
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise(result));
  } catch (error) {
    if (error instanceof TransferConflictError || error instanceof BatchInventoryError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("This allocation or transfer request was already posted. Refresh before trying again.", 409);
    return publicError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorize("inventory.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return fail("The request body must be valid JSON.", 400); }
    const input = stockTransferActionSchema.safeParse(body);
    if (!input.success) return fail("Check the transfer action.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const transferId = new ObjectId(input.data.id);
    const existing = await db.collection("stockTransfers").findOne({ _id: transferId });
    if (!existing) return fail("This stock transfer could not be found.", 404);
    const targetStatus = input.data.action === "RECEIVE" ? "RECEIVED" : "CANCELLED";
    if (existing.status === targetStatus) return ok(serialise(existing));
    if (existing.status !== "IN_TRANSIT") return fail("This transfer is no longer in transit.", 409);

    const client = await getMongoClient();
    const mongoSession = client.startSession();
    let result: Record<string, unknown> | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const transfer = await db.collection("stockTransfers").findOne({ _id: transferId, status: "IN_TRANSIT", version: input.data.version }, { session: mongoSession });
        if (!transfer) throw new TransferConflictError("This transfer changed while you were reviewing it. Refresh and try again.");
        const now = new Date();
        const actorId = new ObjectId(auth.session.id);
        const returnToSource = input.data.action === "CANCEL";
        const locationId = returnToSource ? transfer.sourceLocationId : transfer.destinationLocationId;
        const locationCode = returnToSource ? transfer.sourceLocationCode : transfer.destinationLocationCode;
        const locationName = returnToSource ? transfer.sourceLocationName : transfer.destinationLocationName;
        for (const item of transfer.items as Array<Record<string, unknown>>) {
          await db.collection("inventoryBalances").updateOne(
            { productId: item.productId, locationId },
            {
              $inc: { quantity: Number(item.quantity) },
              $set: { sku: item.sku, productName: item.productName, locationCode, locationName, updatedAt: now },
              $setOnInsert: { _id: new ObjectId(), createdBy: actorId, createdAt: now },
            },
            { upsert: true, session: mongoSession },
          );
          await db.collection("stockMovements").insertOne({
            productId: item.productId, sku: item.sku, productName: item.productName, quantity: Number(item.quantity),
            type: returnToSource ? "TRANSFER_CANCEL" : "TRANSFER_IN", reason: transfer.transferNo, referenceId: transfer._id, referenceNo: transfer.transferNo, affectsGlobalStock: false,
            locationId, locationCode, locationName,
            sourceLocationId: transfer.sourceLocationId, sourceLocationCode: transfer.sourceLocationCode, sourceLocationName: transfer.sourceLocationName,
            destinationLocationId: transfer.destinationLocationId, destinationLocationCode: transfer.destinationLocationCode, destinationLocationName: transfer.destinationLocationName,
            createdBy: actorId, createdAt: now,
          }, { session: mongoSession });
          const allocations = Array.isArray(item.batchAllocations) ? item.batchAllocations : [];
          for (const allocation of allocations as Array<Record<string, unknown>>) {
            await addInventoryBatchQuantity(db, {
              productId: item.productId as ObjectId,
              sku: String(item.sku),
              productName: String(item.productName),
              locationId: locationId as ObjectId,
              locationCode: String(locationCode),
              locationName: String(locationName),
              allocation: {
                lotNo: String(allocation.lotNo), lotKey: String(allocation.lotKey || allocation.lotNo),
                expiryDate: String(allocation.expiryDate), quantity: Number(allocation.quantity),
                ...(allocation.supplierId instanceof ObjectId || allocation.supplierId === null ? { supplierId: allocation.supplierId } : {}),
                ...(allocation.supplierName ? { supplierName: String(allocation.supplierName) } : {}),
                ...(allocation.goodsReceiptId instanceof ObjectId || allocation.goodsReceiptId === null ? { goodsReceiptId: allocation.goodsReceiptId } : {}),
                ...(allocation.goodsReceiptNo ? { goodsReceiptNo: String(allocation.goodsReceiptNo) } : {}),
              },
              actorId, now,
            }, mongoSession);
          }
        }
        const set = input.data.action === "RECEIVE"
          ? { status: targetStatus, receivedBy: actorId, receivedByName: auth.session.fullName, receivedAt: now, completionNote: input.data.note, updatedAt: now }
          : { status: targetStatus, cancelledBy: actorId, cancelledByName: auth.session.fullName, cancelledAt: now, completionNote: input.data.note, updatedAt: now };
        const updated = await db.collection("stockTransfers").findOneAndUpdate(
          { _id: transferId, status: "IN_TRANSIT", version: input.data.version },
          { $set: set, $inc: { version: 1 } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!updated) throw new TransferConflictError("This transfer changed while you were reviewing it. Refresh and try again.");
        await writeAudit(db, auth.session, input.data.action === "RECEIVE" ? "inventory.transfer_receive" : "inventory.transfer_cancel", "stockTransfer", input.data.id, { transferNo: transfer.transferNo, note: input.data.note, totalUnits: transfer.totalUnits }, mongoSession);
        result = updated;
      });
    } finally {
      await mongoSession.endSession();
    }
    return ok(serialise(result));
  } catch (error) {
    if (error instanceof TransferConflictError || error instanceof BatchInventoryError) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000) return fail("The destination inventory changed during receipt. Refresh and try again.", 409);
    return publicError(error);
  }
}
