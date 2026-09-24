import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { AccountingPeriodClosedError } from "@/lib/accounting-periods";
import { assertAccountingPeriodOpen } from "@/lib/accounting-period-lock";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";
import { dateKeyInTimeZone } from "@/lib/dates";
import { getDb, getMongoClient } from "@/lib/db";
import { applyDimensionAllocation } from "@/lib/dimension-allocation";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";
import { ensureProcurementAccounts } from "@/lib/procurement";
import {
  allocatePurchaseReceiptLineFinancials, purchaseReturnObjectId, purchaseReturnSchema,
  PurchaseReturnError, slicePurchaseReturnLine,
} from "@/lib/purchase-returns";

export const runtime = "nodejs";
export const maxDuration = 30;

function dateKey(value: unknown) {
  const parsed = new Date(value as string | number | Date);
  if (Number.isNaN(parsed.getTime())) throw new PurchaseReturnError("Choose a valid return date.", 422);
  return parsed.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const auth = await authorize("purchasing.read");
  if (auth.error) return auth.error;
  const billId = new URL(request.url).searchParams.get("billId") || "";
  if (!ObjectId.isValid(billId)) return fail("The supplier bill reference is invalid.", 422);
  try {
    const db = await getDb();
    const bill = await db.collection("accountsPayableBills").findOne({ _id: new ObjectId(billId) });
    if (!bill) return fail("This supplier bill could not be found.", 404);
    const [receipt, returns] = await Promise.all([
      db.collection("goodsReceipts").findOne({ _id: bill.goodsReceiptId }),
      db.collection("purchaseReturns").find({ billId: bill._id }).sort({ returnedAt: -1, createdAt: -1 }).toArray(),
    ]);
    if (!receipt) return fail("The source goods receipt could not be found.", 409);
    const productIds = (receipt.items || []).map((line: Record<string, unknown>) => line.productId as ObjectId);
    const [products, balances, batches] = await Promise.all([
      db.collection("products").find({ _id: { $in: productIds } }).project({ stock: 1, cost: 1, batchTracked: 1 }).toArray(),
      db.collection("inventoryBalances").find({ productId: { $in: productIds } }).project({ productId: 1, locationId: 1, quantity: 1 }).toArray(),
      db.collection("inventoryBatches").find({ productId: { $in: productIds }, locationId: receipt.locationId }).project({ productId: 1, lotKey: 1, expiryDate: 1, quantity: 1 }).toArray(),
    ]);
    const productMap = new Map(products.map(product => [String(product._id), product]));
    const trackedProductIds = new Set(balances.map(balance => String(balance.productId)));
    const balanceMap = new Map(balances.filter(balance => String(balance.locationId) === String(receipt.locationId)).map(balance => [String(balance.productId), Number(balance.quantity || 0)]));
    const enriched = allocatePurchaseReceiptLineFinancials(receipt.items || [], {
      netSales: roundCurrency(Number(receipt.total) - Number(receipt.tax), String(receipt.currency)),
      tax: Number(receipt.tax), total: Number(receipt.total), baseTax: Number(receipt.baseTax),
    }, String(receipt.currency), String(receipt.baseCurrency)).map(line => {
      const product = productMap.get(String(line.productId));
      const batch = batches.find(item => String(item.productId) === String(line.productId) && String(item.lotKey) === String(line.lotKey || "") && String(item.expiryDate) === String(line.expiryDate || ""));
      const companyStock = Number(product?.stock || 0);
      const locationStock = trackedProductIds.has(String(line.productId)) ? Number(balanceMap.get(String(line.productId)) || 0) : companyStock;
      const availableStock = product?.batchTracked ? Math.min(companyStock, locationStock, Number(batch?.quantity || 0)) : Math.min(companyStock, locationStock);
      return { ...line, batchTracked: product?.batchTracked === true, availableStock: Math.max(0, availableStock), returnableQuantity: Math.max(0, Number(line.quantity || 0) - Number(line.returnedQuantity || 0)) };
    });
    return ok(serialise({ bill, receipt: { ...receipt, items: enriched }, returns }));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let body: unknown;
  try { body = await request.json(); } catch { return fail("The request body must be valid JSON.", 400); }
  const input = purchaseReturnSchema.safeParse(body);
  if (!input.success) return fail("Check the purchase return details.", 422, input.error.flatten().fieldErrors);
  const returnId = new ObjectId(purchaseReturnObjectId(input.data.clientRequestId));
  try {
    const db = await getDb();
    const existing = await db.collection("purchaseReturns").findOne({ _id: returnId });
    if (existing) return ok(serialise(existing));
    const client = await getMongoClient();
    const session = client.startSession();
    const returnNo = makeDocumentNo("PRN");
    const journalNo = makeDocumentNo("JE");
    let result: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(async () => {
        await touchBusinessKeyLock(db, businessKeyLockId("purchase-return-request", input.data.clientRequestId), session);
        const duplicate = await db.collection("purchaseReturns").findOne({ _id: returnId }, { session });
        if (duplicate) { result = duplicate; return; }
        const bill = await db.collection("accountsPayableBills").findOne({ _id: new ObjectId(input.data.billId) }, { session });
        if (!bill) throw new PurchaseReturnError("This supplier bill could not be found.", 404);
        const actualVersion = new Date(bill.updatedAt).getTime();
        if (!Number.isFinite(actualVersion) || actualVersion !== new Date(input.data.expectedUpdatedAt).getTime()) throw new PurchaseReturnError("This supplier bill changed. Refresh before returning goods.");
        if (bill.status !== "OPEN" || Number(bill.paidAmount || 0) !== 0) throw new PurchaseReturnError("Only an unpaid open supplier bill can be reduced by a goods return. Record a supplier credit separately after payment.");
        const creditKey = input.data.supplierCreditNo.trim().toUpperCase();
        await touchBusinessKeyLock(db, businessKeyLockId("supplier-credit", String(bill.supplierId), creditKey), session);
        const reusedCredit = await db.collection("purchaseReturns").findOne({ supplierId: bill.supplierId, supplierCreditNoNormalized: creditKey }, { session });
        if (reusedCredit) throw new PurchaseReturnError("This supplier credit note has already been recorded.");
        const receipt = await db.collection("goodsReceipts").findOne({ _id: bill.goodsReceiptId }, { session });
        if (!receipt) throw new PurchaseReturnError("The source goods receipt could not be found.");
        const returnDay = dateKey(input.data.returnedAt);
        const receiptDay = dateKey(receipt.receivedAt);
        const timeZone = String(bill.timeZone || "UTC");
        if (returnDay < receiptDay || returnDay > dateKeyInTimeZone(new Date(), timeZone)) throw new PurchaseReturnError("Return date cannot precede the receipt or be in the future.", 422);
        await assertAccountingPeriodOpen(db, returnDay, session);
        const requested = new Map(input.data.lines.map(line => [line.productId, line.quantity]));
        const receiptLines = allocatePurchaseReceiptLineFinancials(receipt.items || [], {
          netSales: roundCurrency(Number(receipt.total) - Number(receipt.tax), String(receipt.currency)),
          tax: Number(receipt.tax), total: Number(receipt.total), baseTax: Number(receipt.baseTax),
        }, String(receipt.currency), String(receipt.baseCurrency));
        const selected = receiptLines.filter(line => requested.has(String(line.productId)));
        if (selected.length !== requested.size) throw new PurchaseReturnError("A selected product is not on this goods receipt.", 422);
        for (const line of selected) {
          const available = Number(line.quantity || 0) - Number(line.returnedQuantity || 0);
          if (requested.get(String(line.productId))! > available) throw new PurchaseReturnError(`${String(line.productName)} has only ${available} units left to return.`, 422);
        }
        const products = await db.collection("products").find({ _id: { $in: selected.map(line => line.productId as ObjectId) } }, { session }).toArray();
        if (products.length !== selected.length) throw new PurchaseReturnError("A received product no longer exists. Restore its product record before returning it.");
        const productMap = new Map(products.map(product => [String(product._id), product]));
        const inventoryBalances = await db.collection("inventoryBalances").find(
          { productId: { $in: selected.map(line => line.productId as ObjectId) } },
          { session },
        ).toArray();
        const trackedProductIds = new Set(inventoryBalances.map(balance => String(balance.productId)));
        const locationBalanceMap = new Map(inventoryBalances
          .filter(balance => String(balance.locationId) === String(receipt.locationId))
          .map(balance => [String(balance.productId), balance]));
        const now = new Date();
        const returnLines = selected.map(line => {
          const quantity = requested.get(String(line.productId))!;
          const product = productMap.get(String(line.productId))!;
          const amounts = slicePurchaseReturnLine(line, Number(line.returnedQuantity || 0), quantity, String(receipt.currency), String(receipt.baseCurrency));
          return {
            productId: line.productId, sku: line.sku, productName: line.productName, unit: line.unit,
            quantity, unitCost: line.unitCost, ...amounts,
            carryingInventoryValue: roundCurrency(Number(product.cost || 0) * quantity, String(receipt.baseCurrency)),
            ...(line.lotNo ? { lotNo: line.lotNo, lotKey: line.lotKey, expiryDate: line.expiryDate } : {}),
          };
        });
        const currency = String(receipt.currency);
        const baseCurrency = String(receipt.baseCurrency);
        const supplierNet = roundCurrency(returnLines.reduce((sum, line) => sum + line.supplierNet, 0), currency);
        const supplierTax = roundCurrency(returnLines.reduce((sum, line) => sum + line.supplierTax, 0), currency);
        const supplierTotal = roundCurrency(returnLines.reduce((sum, line) => sum + line.supplierTotal, 0), currency);
        const baseTax = roundCurrency(returnLines.reduce((sum, line) => sum + line.baseTax, 0), baseCurrency);
        const baseTotal = roundCurrency(returnLines.reduce((sum, line) => sum + line.baseTotal, 0), baseCurrency);
        const inventoryValue = roundCurrency(returnLines.reduce((sum, line) => sum + line.carryingInventoryValue, 0), baseCurrency);
        if (currencyMinorUnits(supplierTotal, currency) > currencyMinorUnits(Number(bill.balance), currency) || currencyMinorUnits(baseTotal, baseCurrency) > currencyMinorUnits(Number(bill.baseBalance), baseCurrency)) throw new PurchaseReturnError("The return exceeds the unpaid supplier bill balance.");
        for (const line of returnLines) {
          const product = productMap.get(String(line.productId))!;
          const oldStock = Number(product.stock || 0);
          if (line.quantity > oldStock) throw new PurchaseReturnError(`${String(line.productName)} has only ${oldStock} units in company stock.`);
          const locationBalance = locationBalanceMap.get(String(product._id));
          if (!locationBalance && trackedProductIds.has(String(product._id))) throw new PurchaseReturnError(`${String(line.productName)} has no stock at ${String(receipt.locationName)}.`);
          if (locationBalance) {
            if (line.quantity > Number(locationBalance.quantity || 0)) throw new PurchaseReturnError(`${String(line.productName)} does not have enough stock at ${String(receipt.locationName)}.`);
            const locationUpdate = await db.collection("inventoryBalances").updateOne(
              { _id: locationBalance._id, quantity: locationBalance.quantity },
              { $inc: { quantity: -line.quantity }, $set: { updatedAt: now } },
              { session },
            );
            if (!locationUpdate.modifiedCount) throw new PurchaseReturnError(`${String(line.productName)} location stock changed. Refresh and retry.`);
          }
          if (product.batchTracked) {
            if (!line.lotKey || !line.expiryDate) throw new PurchaseReturnError(`${String(line.productName)} receipt has no batch identity and cannot be returned automatically.`);
            const batchUpdate = await db.collection("inventoryBatches").updateOne(
              { productId: product._id, locationId: receipt.locationId, lotKey: line.lotKey, expiryDate: line.expiryDate, quantity: { $gte: line.quantity } },
              { $inc: { quantity: -line.quantity, version: 1 }, $set: { updatedAt: now } },
              { session },
            );
            if (!batchUpdate.modifiedCount) throw new PurchaseReturnError(`${String(line.productName)} does not have enough of receipt lot ${String(line.lotNo)} at this location.`);
          }
          const productUpdate = await db.collection("products").updateOne(
            { _id: product._id, stock: oldStock },
            { $inc: { stock: -line.quantity }, $set: { updatedAt: now } },
            { session },
          );
          if (!productUpdate.modifiedCount) throw new PurchaseReturnError(`${String(line.productName)} stock changed. Refresh and retry.`);
          await db.collection("stockMovements").insertOne({
            productId: product._id, sku: line.sku, productName: line.productName, quantity: -line.quantity,
            type: "PURCHASE_RETURN", reason: input.data.reason, referenceId: returnId, referenceNo: returnNo,
            purchaseOrderId: receipt.purchaseOrderId, purchaseOrderNo: receipt.purchaseOrderNo,
            supplierId: receipt.supplierId, supplierName: receipt.supplierName,
            unitCost: product.cost, locationId: receipt.locationId, locationCode: receipt.locationCode, locationName: receipt.locationName,
            createdBy: new ObjectId(auth.session.id), movementDate: input.data.returnedAt, createdAt: now,
          }, { session });
        }
        const updatedReceiptItems = receiptLines.map(line => {
          const returned = returnLines.find(item => String(item.productId) === String(line.productId));
          return returned ? {
            ...line,
            returnedQuantity: Number(line.returnedQuantity || 0) + returned.quantity,
            returnedSupplierTotal: roundCurrency(Number(line.returnedSupplierTotal || 0) + returned.supplierTotal, currency),
            returnedBaseTotal: roundCurrency(Number(line.returnedBaseTotal || 0) + returned.baseTotal, baseCurrency),
          } : line;
        });
        const fullyReturned = updatedReceiptItems.every(line => Number(line.returnedQuantity || 0) >= Number(line.quantity || 0));
        await db.collection("goodsReceipts").updateOne(
          { _id: receipt._id },
          { $set: { items: updatedReceiptItems, status: fullyReturned ? "RETURNED" : "PARTIALLY_RETURNED", updatedAt: now }, $push: { returnIds: returnId } as never },
          { session },
        );
        const supplierBalance = roundCurrency(Number(bill.balance) - supplierTotal, currency);
        const baseBalance = roundCurrency(Number(bill.baseBalance) - baseTotal, baseCurrency);
        const billStatus = currencyMinorUnits(supplierBalance, currency) === 0 && currencyMinorUnits(baseBalance, baseCurrency) === 0 ? "CREDITED" : "OPEN";
        const updatedBill = await db.collection("accountsPayableBills").findOneAndUpdate(
          { _id: bill._id, status: "OPEN", paidAmount: 0, updatedAt: bill.updatedAt },
          { $set: { balance: supplierBalance, baseBalance, status: billStatus, updatedAt: now }, $inc: { creditedAmount: supplierTotal, baseCreditedAmount: baseTotal }, $push: { returnIds: returnId } as never },
          { returnDocument: "after", session },
        );
        if (!updatedBill) throw new PurchaseReturnError("The supplier bill changed while the return was posting. Refresh and retry.");
        const order = await db.collection("purchaseOrders").findOne({ _id: receipt.purchaseOrderId }, { session });
        if (order) {
          const orderItems = order.items.map((line: Record<string, unknown>) => ({ ...line, returnedQuantity: Number(line.returnedQuantity || 0) + (requested.get(String(line.productId)) || 0) }));
          await db.collection("purchaseOrders").updateOne({ _id: order._id }, { $set: { items: orderItems, updatedAt: now } }, { session });
        }
        const returnVariance = roundCurrency(baseTotal - baseTax - inventoryValue, baseCurrency);
        const purchaseReturn = {
          _id: returnId, clientRequestId: input.data.clientRequestId, returnNo,
          billId: bill._id, billNo: bill.billNo, goodsReceiptId: receipt._id, receiptNo: receipt.receiptNo,
          purchaseOrderId: receipt.purchaseOrderId, purchaseOrderNo: receipt.purchaseOrderNo,
          supplierId: receipt.supplierId, supplierCode: receipt.supplierCode, supplierName: receipt.supplierName,
          supplierCreditNo: input.data.supplierCreditNo, supplierCreditNoNormalized: creditKey,
          locationId: receipt.locationId, locationCode: receipt.locationCode, locationName: receipt.locationName,
          items: returnLines, currency, baseCurrency, supplierNet, supplierTax, supplierTotal,
          baseTax, baseTotal, inventoryValue, returnVariance, reason: input.data.reason,
          dimensionAllocation: receipt.dimensionAllocation || null,
          returnedAt: input.data.returnedAt, createdBy: new ObjectId(auth.session.id), createdByName: auth.session.fullName, createdAt: now,
        };
        await db.collection("purchaseReturns").insertOne(purchaseReturn, { session });
        await ensureProcurementAccounts(db, new ObjectId(auth.session.id), session);
        const varianceDebit = Math.max(0, -returnVariance);
        const varianceCredit = Math.max(0, returnVariance);
        const journalLines = [
          { accountCode: "2000", accountName: "Accounts payable", debit: baseTotal, credit: 0 },
          ...(varianceDebit > 0 ? [{ accountCode: "5200", accountName: "Purchase return variance", debit: varianceDebit, credit: 0 }] : []),
          { accountCode: "1200", accountName: "Inventory", debit: 0, credit: inventoryValue },
          ...(baseTax > 0 ? [{ accountCode: "1300", accountName: "Input tax recoverable", debit: 0, credit: baseTax }] : []),
          ...(varianceCredit > 0 ? [{ accountCode: "5200", accountName: "Purchase return variance", debit: 0, credit: varianceCredit }] : []),
        ];
        const journalTotal = roundCurrency(baseTotal + varianceDebit, baseCurrency);
        await db.collection("journalEntries").insertOne({
          entryNo: journalNo, date: input.data.returnedAt, businessDate: returnDay, timeZone,
          memo: `Purchase return ${returnNo} · ${receipt.supplierName}`, reference: input.data.supplierCreditNo,
          source: "PURCHASE_RETURN", sourceId: returnId, status: "POSTED",
          lines: applyDimensionAllocation(journalLines, receipt.dimensionAllocation, baseCurrency),
          totalDebit: journalTotal, totalCredit: journalTotal,
          createdBy: new ObjectId(auth.session.id), createdAt: now,
        }, { session });
        await db.collection("suppliers").updateOne({ _id: receipt.supplierId }, { $inc: { returnedBaseValue: baseTotal }, $set: { lastReturnAt: input.data.returnedAt, updatedAt: now } }, { session });
        await writeAudit(db, auth.session, "purchase.return", "goodsReceipt", String(receipt._id), {
          returnNo, billNo: bill.billNo, supplierCreditNo: input.data.supplierCreditNo,
          supplierTotal, currency, baseTotal, baseCurrency, inventoryValue, returnVariance, reason: input.data.reason,
        }, session);
        result = { purchaseReturn, bill: updatedBill };
      });
    } finally { await session.endSession(); }
    return created(serialise(result));
  } catch (error) {
    if (error instanceof AccountingPeriodClosedError) return fail(error.message, error.status);
    if (error instanceof PurchaseReturnError) return fail(error.message, error.status);
    return publicError(error);
  }
}
