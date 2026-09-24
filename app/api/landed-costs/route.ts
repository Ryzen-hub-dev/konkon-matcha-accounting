import { ObjectId } from "mongodb";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { AccountingPeriodClosedError } from "@/lib/accounting-periods";
import { assertAccountingPeriodOpen } from "@/lib/accounting-period-lock";
import { businessKeyLockId, touchBusinessKeyLock } from "@/lib/business-key-lock";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { dateKeyInTimeZone } from "@/lib/dates";
import { applyDimensionAllocation, dimensionRuleAuditId } from "@/lib/dimension-allocation";
import { readExchangeRate } from "@/lib/exchange-rates";
import { makeDocumentNo, serialise } from "@/lib/format";
import { currencyMinorUnits, roundCurrency } from "@/lib/international";
import { allocateLandedCost, landedCostInputSchema } from "@/lib/landed-costs";
import { ensureProcurementAccounts } from "@/lib/procurement";

export const runtime = "nodejs";

class LandedCostError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

function dateKey(value: unknown) {
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) throw new LandedCostError("Choose a valid landed-cost date.", 422);
  return date.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const auth = await authorize("purchasing.read");
  if (auth.error) return auth.error;
  const receiptId = new URL(request.url).searchParams.get("receiptId") || "";
  if (receiptId && !ObjectId.isValid(receiptId)) return fail("The goods receipt reference is invalid.", 422);
  try {
    const db = await getDb();
    const records = await db.collection("landedCosts")
      .find(receiptId ? { goodsReceiptId: new ObjectId(receiptId) } : {})
      .sort({ postedAt: -1, createdAt: -1 })
      .limit(300)
      .toArray();
    return ok(serialise(records));
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("purchasing.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  let body: unknown;
  try { body = await request.json(); }
  catch { return fail("The request body must be valid JSON.", 400); }
  const input = landedCostInputSchema.safeParse(body);
  if (!input.success) return fail("Check the landed-cost invoice.", 422, input.error.flatten().fieldErrors);
  try {
    const db = await getDb();
    const existing = await db.collection("landedCosts").findOne({ clientRequestId: input.data.clientRequestId });
    if (existing) {
      const bill = await db.collection("accountsPayableBills").findOne({ landedCostId: existing._id });
      return ok(serialise({ landedCost: existing, bill }));
    }
    const client = await getMongoClient();
    const session = client.startSession();
    const landedCostId = new ObjectId();
    const billId = new ObjectId();
    const landedCostNo = makeDocumentNo("LDC");
    const billNo = makeDocumentNo("APB");
    const journalNo = makeDocumentNo("JE");
    let result: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(async () => {
        await touchBusinessKeyLock(db, businessKeyLockId("LANDED_COST_REQUEST", input.data.clientRequestId), session);
        const repeated = await db.collection("landedCosts").findOne({ clientRequestId: input.data.clientRequestId }, { session });
        if (repeated) {
          const repeatedBill = await db.collection("accountsPayableBills").findOne({ landedCostId: repeated._id }, { session });
          result = { landedCost: repeated, bill: repeatedBill };
          return;
        }
        const [receipt, supplier, settings] = await Promise.all([
          db.collection("goodsReceipts").findOne({ _id: new ObjectId(input.data.receiptId) }, { session }),
          db.collection("suppliers").findOne({ _id: new ObjectId(input.data.supplierId), active: { $ne: false } }, { session }),
          db.collection("settings").findOne({ key: "business" }, { session }),
        ]);
        if (!receipt) throw new LandedCostError("The source goods receipt could not be found.", 404);
        if (!supplier) throw new LandedCostError("Choose an active landed-cost supplier.", 422);
        const business = normaliseBusinessSettings(settings);
        const baseCurrency = String(receipt.baseCurrency || business.currency);
        if (baseCurrency !== business.currency) throw new LandedCostError("The goods receipt accounting currency no longer matches this workspace.");
        const postedDay = dateKey(input.data.postedAt);
        const invoiceDay = dateKey(input.data.invoiceDate);
        const receiptDay = dateKey(receipt.receivedAt);
        const timeZone = String(receipt.timeZone || business.timeZone || "UTC");
        const today = dateKeyInTimeZone(new Date(), timeZone);
        if (postedDay < receiptDay || postedDay > today) throw new LandedCostError("Posting date cannot precede the goods receipt or be in the future.", 422);
        if (invoiceDay > postedDay) throw new LandedCostError("Supplier invoice date cannot be after the landed-cost posting date.", 422);
        await assertAccountingPeriodOpen(db, postedDay, session);
        const currency = String(supplier.currency || baseCurrency);
        const exchange = await readExchangeRate(db, baseCurrency, currency);
        if (!exchange) throw new LandedCostError(`Configure an active ${baseCurrency}/${currency} exchange rate before posting this invoice.`);
        const total = roundCurrency(input.data.total, currency);
        const tax = roundCurrency(input.data.tax, currency);
        if (currencyMinorUnits(tax, currency) > currencyMinorUnits(total, currency)) throw new LandedCostError("Tax cannot exceed the landed-cost invoice total.", 422);
        const baseTotal = roundCurrency(total / exchange.rate, baseCurrency);
        const baseTax = roundCurrency(tax / exchange.rate, baseCurrency);
        const baseCost = roundCurrency(baseTotal - baseTax, baseCurrency);
        if (currencyMinorUnits(baseCost, baseCurrency) <= 0) throw new LandedCostError("The landed-cost invoice needs a positive amount before tax.", 422);
        const invoiceKey = input.data.supplierInvoiceNo.trim().toUpperCase();
        await touchBusinessKeyLock(db, businessKeyLockId("SUPPLIER_INVOICE", String(supplier._id), invoiceKey), session);
        const duplicateInvoice = await db.collection("accountsPayableBills").findOne({ supplierId: supplier._id, supplierInvoiceNoNormalized: invoiceKey }, { session });
        if (duplicateInvoice) throw new LandedCostError("This supplier invoice is already in accounts payable.");

        const receiptItems = Array.isArray(receipt.items) ? receipt.items : [];
        if (!receiptItems.length) throw new LandedCostError("The goods receipt has no products to allocate.");
        const productIds = receiptItems.map((line: Record<string, unknown>) => line.productId as ObjectId);
        const [products, batches] = await Promise.all([
          db.collection("products").find({ _id: { $in: productIds } }, { session }).toArray(),
          db.collection("inventoryBatches").find({ productId: { $in: productIds }, locationId: receipt.locationId }, { session }).toArray(),
        ]);
        if (products.length !== new Set(productIds.map(String)).size) throw new LandedCostError("A received product no longer exists. Restore it before allocating landed cost.");
        const productMap = new Map(products.map(product => [String(product._id), product]));
        const allocations = allocateLandedCost({
          amount: baseCost,
          currency: baseCurrency,
          basis: input.data.allocationBasis,
          lines: receiptItems.map((line: Record<string, unknown>) => {
            const product = productMap.get(String(line.productId))!;
            const batch = product.batchTracked
              ? batches.find(item => String(item.productId) === String(line.productId)
                && String(item.lotKey) === String(line.lotKey || "")
                && String(item.expiryDate) === String(line.expiryDate || ""))
              : null;
            // ponytail: non-batch stock uses the existing moving-average pool; add receipt layers only when the inventory engine supports layer costing end to end.
            return {
              productId: String(line.productId),
              quantity: Number(line.quantity || 0),
              returnedQuantity: Number(line.returnedQuantity || 0),
              baseInventoryValue: Number(line.baseInventoryValue || 0),
              currentStock: Number(product.stock || 0),
              ...(product.batchTracked ? { retainedStock: Number(batch?.quantity || 0) } : {}),
            };
          }),
        });
        const now = new Date();
        for (const allocation of allocations) {
          if (currencyMinorUnits(allocation.inventoryAmount, baseCurrency) <= 0) continue;
          const product = productMap.get(allocation.productId)!;
          const currentStock = Number(product.stock || 0);
          if (currentStock <= 0) throw new LandedCostError(`${String(product.name)} stock changed while landed cost was being allocated.`);
          const currentCost = Number(product.cost || 0);
          const nextCost = roundCurrency(currentCost + allocation.unitCostIncrease, baseCurrency);
          const updated = await db.collection("products").updateOne(
            { _id: product._id, stock: product.stock, cost: product.cost },
            { $set: { cost: nextCost, updatedAt: now } },
            { session },
          );
          if (!updated.modifiedCount) throw new LandedCostError(`${String(product.name)} stock or cost changed. Refresh and retry.`);
        }
        const allocationMap = new Map(allocations.map(line => [line.productId, line]));
        const updatedReceiptItems = receiptItems.map((line: Record<string, unknown>) => {
          const allocation = allocationMap.get(String(line.productId))!;
          return {
            ...line,
            landedCostBase: roundCurrency(Number(line.landedCostBase || 0) + allocation.allocatedAmount, baseCurrency),
            landedCostInventoryBase: roundCurrency(Number(line.landedCostInventoryBase || 0) + allocation.inventoryAmount, baseCurrency),
            landedCostExpenseBase: roundCurrency(Number(line.landedCostExpenseBase || 0) + allocation.expenseAmount, baseCurrency),
          };
        });
        const receiptFilter = receipt.updatedAt
          ? { _id: receipt._id, updatedAt: receipt.updatedAt }
          : { _id: receipt._id, updatedAt: { $exists: false } };
        const receiptUpdate = await db.collection("goodsReceipts").updateOne(
          receiptFilter,
          { $set: { items: updatedReceiptItems, updatedAt: now }, $inc: { landedCostBase: baseCost, landedCostVersion: 1 }, $push: { landedCostIds: landedCostId } as never },
          { session },
        );
        if (!receiptUpdate.modifiedCount) throw new LandedCostError("The goods receipt changed while landed cost was posting. Refresh and retry.");
        const inventoryAmount = roundCurrency(allocations.reduce((sum, line) => sum + line.inventoryAmount, 0), baseCurrency);
        const expenseAmount = roundCurrency(allocations.reduce((sum, line) => sum + line.expenseAmount, 0), baseCurrency);
        const dueDate = new Date(input.data.invoiceDate.getTime() + Number(supplier.paymentTermsDays || 0) * 86_400_000);
        const landedCost = {
          _id: landedCostId,
          clientRequestId: input.data.clientRequestId,
          landedCostNo,
          goodsReceiptId: receipt._id,
          receiptNo: receipt.receiptNo,
          purchaseOrderId: receipt.purchaseOrderId,
          purchaseOrderNo: receipt.purchaseOrderNo,
          supplierId: supplier._id,
          supplierCode: supplier.code,
          supplierName: supplier.name,
          supplierInvoiceNo: input.data.supplierInvoiceNo,
          supplierInvoiceNoNormalized: invoiceKey,
          category: input.data.category,
          allocationBasis: input.data.allocationBasis,
          description: input.data.description,
          currency,
          baseCurrency,
          exchangeRate: exchange.rate,
          exchangeRateSource: exchange.source,
          total,
          tax,
          baseTotal,
          baseTax,
          baseCost,
          inventoryAmount,
          expenseAmount,
          allocations,
          invoiceDate: input.data.invoiceDate,
          postedAt: input.data.postedAt,
          createdBy: new ObjectId(auth.session.id),
          createdByName: auth.session.fullName,
          createdAt: now,
        };
        const bill = {
          _id: billId,
          billNo,
          billType: "LANDED_COST",
          landedCostId,
          goodsReceiptId: receipt._id,
          receiptNo: receipt.receiptNo,
          purchaseOrderId: receipt.purchaseOrderId,
          purchaseOrderNo: receipt.purchaseOrderNo,
          supplierId: supplier._id,
          supplierCode: supplier.code,
          supplierName: supplier.name,
          supplierInvoiceNo: input.data.supplierInvoiceNo,
          supplierInvoiceNoNormalized: invoiceKey,
          invoiceDate: input.data.invoiceDate,
          dueDate,
          currency,
          baseCurrency,
          timeZone,
          exchangeRate: exchange.rate,
          exchangeRateSource: exchange.source,
          total,
          tax,
          baseTax,
          baseTotal,
          paidAmount: 0,
          balance: total,
          baseSettledAmount: 0,
          baseBalance: baseTotal,
          status: "OPEN",
          createdBy: new ObjectId(auth.session.id),
          createdAt: now,
          updatedAt: now,
        };
        await ensureProcurementAccounts(db, new ObjectId(auth.session.id), session);
        await db.collection("landedCosts").insertOne(landedCost, { session });
        await db.collection("accountsPayableBills").insertOne(bill, { session });
        const dimensionAllocation = receipt.dimensionAllocation || null;
        const journalLines = [
          ...(inventoryAmount > 0 ? [{ accountCode: "1200", accountName: "Inventory", debit: inventoryAmount, credit: 0 }] : []),
          ...(expenseAmount > 0 ? [{ accountCode: "5000", accountName: "Cost of goods sold", debit: expenseAmount, credit: 0 }] : []),
          ...(baseTax > 0 ? [{ accountCode: "1300", accountName: "Input tax recoverable", debit: baseTax, credit: 0 }] : []),
          { accountCode: "2000", accountName: "Accounts payable", debit: 0, credit: baseTotal },
        ];
        await db.collection("journalEntries").insertOne({
          entryNo: journalNo,
          date: input.data.postedAt,
          businessDate: postedDay,
          timeZone,
          memo: `Landed cost ${landedCostNo} · ${receipt.receiptNo}`,
          reference: input.data.supplierInvoiceNo,
          source: "LANDED_COST",
          sourceId: landedCostId,
          status: "POSTED",
          lines: applyDimensionAllocation(journalLines, dimensionAllocation, baseCurrency),
          totalDebit: baseTotal,
          totalCredit: baseTotal,
          createdBy: new ObjectId(auth.session.id),
          createdAt: now,
        }, { session });
        await writeAudit(db, auth.session, "landed_cost.post", "landedCost", String(landedCostId), {
          landedCostNo,
          receiptNo: receipt.receiptNo,
          billNo,
          supplierInvoiceNo: input.data.supplierInvoiceNo,
          category: input.data.category,
          allocationBasis: input.data.allocationBasis,
          total,
          currency,
          baseCost,
          inventoryAmount,
          expenseAmount,
          dimensionRuleId: dimensionRuleAuditId(dimensionAllocation),
        }, session);
        result = { landedCost, bill };
      });
    } finally { await session.endSession(); }
    return created(serialise(result));
  } catch (error) {
    if (error instanceof AccountingPeriodClosedError) return fail(error.message, error.status);
    if (error instanceof LandedCostError) return fail(error.message, error.status);
    if ((error as { code?: number }).code === 11000) return fail("This landed-cost request or supplier invoice was already posted.", 409);
    return publicError(error);
  }
}
