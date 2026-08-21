import { ObjectId } from "mongodb";
import { z } from "zod";
import { authorize, created, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb, getMongoClient } from "@/lib/db";
import { asMoney, makeDocumentNo, serialise } from "@/lib/format";
import { DEFAULT_RECEIPT_TEMPLATE, ensureDefaultReceiptTemplate, normaliseReceiptTemplate } from "@/lib/receipt-templates";
import { calculateTaxTotals } from "@/lib/tax";
import { CouponError, validateCoupon } from "@/lib/coupons";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { quoteAmount, readExchangeRate } from "@/lib/exchange-rates";
import { currencyCodeSchema } from "@/lib/international";
import { effectiveProvider, effectiveVerificationMode, ensureDefaultPaymentMethods, paymentCurrencies } from "@/lib/payment-methods";
import { paymentAmountsMatch, staticQrPaymentIsConfirmed } from "@/lib/payment-verification";

export const runtime = "nodejs";

const saleSchema = z.object({
  clientRequestId: z.string().uuid(),
  memberId: z.union([z.string().length(24), z.literal(""), z.null()]).optional(),
  paymentMethod: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,24}$/),
  paymentReference: z.string().trim().max(80).default(""),
  manualPaymentConfirmed: z.boolean().default(false),
  tenderedAmount: z.coerce.number().min(0).max(100_000_000).optional(),
  tenderCurrency: currencyCodeSchema.optional(),
  paymentIntentId: z.union([z.string().length(24), z.literal("")]).default(""),
  templateId: z.union([z.string().length(24), z.literal("")]).default(""),
  saleNote: z.string().trim().max(300).default(""),
  couponCode: z.string().trim().max(32).default(""),
  manualDiscount: z.coerce.number().min(0).max(100_000).optional(),
  discount: z.coerce.number().min(0).max(100_000).optional(),
  items: z.array(z.object({
    productId: z.string().length(24),
    quantity: z.coerce.number().int().min(1).max(999),
  })).min(1).max(100),
});

class StockError extends Error {}
class PaymentError extends Error {}

async function readBody(request: Request) {
  try {
    return { value: await request.json() } as const;
  } catch {
    return { error: fail("The request body must be valid JSON.", 400) } as const;
  }
}

function escapedSearch(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET(request: Request) {
  const auth = await authorize("receipts.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      if (!ObjectId.isValid(id)) return fail("The receipt reference is invalid.", 422);
      const sale = await db.collection("sales").findOne({ _id: new ObjectId(id) });
      if (!sale) return fail("This receipt could not be found.", 404);
      return ok(serialise(sale));
    }
    const query = url.searchParams.get("q")?.trim().slice(0, 60) || "";
    const filter = query ? {
      $or: ["receiptNo", "memberName", "cashierName", "paymentReference"].map((field) => ({ [field]: { $regex: escapedSearch(query), $options: "i" } })),
    } : {};
    const sales = await db.collection("sales").find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    return ok(serialise(sales));
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("pos.sell");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const body = await readBody(request);
  if (body.error) return body.error;
  let clientRequestId = "";
  try {
    const input = saleSchema.safeParse(body.value);
    if (!input.success) return fail("Check the sale details.", 422, input.error.flatten().fieldErrors);
    clientRequestId = input.data.clientRequestId;
    const quantities = new Map<string, number>();
    for (const item of input.data.items) {
      if (!ObjectId.isValid(item.productId)) return fail("A product in the cart is invalid.", 422);
      quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
    }

    const db = await getDb();
    const existingSale = await db.collection("sales").findOne({ clientRequestId, createdBy: new ObjectId(auth.session.id) });
    if (existingSale) return ok(serialise(existingSale));
    await ensureDefaultReceiptTemplate(db, new ObjectId(auth.session.id));
    await ensureDefaultPaymentMethods(db, new ObjectId(auth.session.id));
    const selectedPayment = await db.collection("paymentMethods").findOne({ code: input.data.paymentMethod, active: { $ne: false } });
    if (!selectedPayment) return fail("Choose an active payment method.", 422, { paymentMethod: ["This payment method is unavailable."] });
    const verificationMode = effectiveVerificationMode(selectedPayment);
    const provider = effectiveProvider(selectedPayment);
    if (verificationMode === "REFERENCE" && !input.data.paymentReference) return fail(`${selectedPayment.name} requires a transaction reference.`, 422, { paymentReference: ["Enter the transaction or approval reference."] });
    if (verificationMode === "STATIC_QR" && String(selectedPayment.qrPayload || "").length < 8) return fail(`${selectedPayment.name} does not have a valid recipient QR configured.`, 409);
    if (verificationMode === "STATIC_QR" && !staticQrPaymentIsConfirmed(input.data.paymentReference, input.data.manualPaymentConfirmed)) return fail("Static QR payments require a receiving-side credit check and transaction reference. Do not release the order.", 422, { paymentReference: ["Confirm the real credit and enter its reference."] });
    if (verificationMode === "PROVIDER" && !ObjectId.isValid(input.data.paymentIntentId)) return fail(`${selectedPayment.name} requires a verified provider confirmation.`, 422, { paymentIntentId: ["Verify the exact payment before checkout."] });
    const ids = [...quantities.keys()].map((id) => new ObjectId(id));
    const products = await db.collection("products").find({ _id: { $in: ids }, active: { $ne: false } }).toArray();
    if (products.length !== ids.length) return fail("One or more products are no longer available.", 409);
    const productMap = new Map(products.map((product) => [product._id.toHexString(), product]));
    const items = [...quantities.entries()].map(([productId, quantity]) => {
      const product = productMap.get(productId)!;
      const price = asMoney(product.price);
      const cost = asMoney(product.cost);
      return {
        productId: product._id,
        sku: String(product.sku),
        name: String(product.name),
        quantity,
        price,
        cost,
        lineTotal: asMoney(price * quantity),
        lineCost: asMoney(cost * quantity),
      };
    });
    const subtotal = asMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
    const manualDiscount = asMoney(input.data.manualDiscount ?? input.data.discount ?? 0);
    if (manualDiscount > 0 && !["OWNER", "ADMIN", "MANAGER"].includes(auth.session.role)) {
      return fail("A Manager must approve a manual discount. Use an active coupon instead.", 403);
    }
    const business = normaliseBusinessSettings(await db.collection("settings").findOne({ key: "business" }));
    const requestedTemplate = input.data.templateId && ObjectId.isValid(input.data.templateId)
      ? await db.collection("receiptTemplates").findOne({ _id: new ObjectId(input.data.templateId), active: { $ne: false } })
      : null;
    if (input.data.templateId && !requestedTemplate) return fail("Choose an available receipt template.", 422);
    const selectedTemplate = requestedTemplate || await db.collection("receiptTemplates").findOne({ isDefault: true, active: { $ne: false } });
    const templateSnapshot = normaliseReceiptTemplate(selectedTemplate || DEFAULT_RECEIPT_TEMPLATE);
    let member = null;
    if (input.data.memberId) {
      member = await db.collection("members").findOne({ _id: new ObjectId(input.data.memberId), active: { $ne: false } });
      if (!member) return fail("The selected member no longer exists.", 409);
    }
    const couponResult = input.data.couponCode
      ? await validateCoupon(db, input.data.couponCode, subtotal, member?._id.toHexString() || null)
      : null;
    const couponDiscount = asMoney(couponResult?.discount || 0);
    const discount = asMoney(manualDiscount + couponDiscount);
    if (discount > subtotal) return fail("Combined discounts cannot exceed the subtotal.", 422);
    const taxMode = business.taxMode;
    const { taxRate, tax, netSales, total } = calculateTaxTotals(subtotal, discount, business.taxRate, taxMode, business.currency);
    const tenderCurrency = input.data.tenderCurrency || business.currency;
    if (!paymentCurrencies(selectedPayment, business.currency, business.acceptedCurrencies).includes(tenderCurrency)) return fail("This payment method does not accept the selected currency.", 422);
    const exchange = await readExchangeRate(db, business.currency, tenderCurrency);
    if (!exchange) return fail(`No active ${business.currency}/${tenderCurrency} exchange rate is configured.`, 409);
    const tenderTotal = quoteAmount(total, exchange.rate, tenderCurrency);
    const isCashPayment = selectedPayment.kind === "CASH";
    const tenderedAmount = isCashPayment ? quoteAmount(Number(input.data.tenderedAmount || 0), 1, tenderCurrency) : tenderTotal;
    if (isCashPayment && tenderedAmount < tenderTotal) {
      return fail("Cash received must cover the amount due.", 422, { tenderedAmount: ["Enter the cash received from the customer."] });
    }
    const changeDue = isCashPayment ? quoteAmount(tenderedAmount - tenderTotal, 1, tenderCurrency) : 0;
    const paymentIntent = verificationMode === "PROVIDER" ? await db.collection("paymentIntents").findOne({
      _id: new ObjectId(input.data.paymentIntentId),
      createdBy: new ObjectId(auth.session.id),
      status: "VERIFIED",
      consumedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
      paymentMethod: selectedPayment.code,
      provider,
      baseCurrency: business.currency,
      tenderCurrency,
    }) : null;
    if (verificationMode === "PROVIDER" && (!paymentIntent
      || !paymentAmountsMatch(total, Number(paymentIntent.baseAmount), business.currency)
      || !paymentAmountsMatch(tenderTotal, Number(paymentIntent.tenderAmount), tenderCurrency))) {
      return fail("The verified payment does not match the current order total, method or currency. Do not release the order.", 409);
    }
    const totalCost = asMoney(items.reduce((sum, item) => sum + item.lineCost, 0));
    const receiptNo = makeDocumentNo("KKM");
    const journalNo = makeDocumentNo("JE");
    const now = new Date();
    const pointsEarned = member ? Math.max(0, Math.floor(total * Number(business?.pointsPerDollar || 1))) : 0;

    const saleId = new ObjectId();
    const sale = {
      _id: saleId,
      clientRequestId,
      receiptNo,
      memberId: member?._id || null,
      memberName: member?.name || "Walk-in guest",
      memberNo: member?.memberNo || "",
      pointsEarned,
      pointsBalance: member ? Number(member.points || 0) + pointsEarned : 0,
      items,
      subtotal,
      discount,
      manualDiscount,
      couponDiscount,
      couponId: couponResult?.coupon._id || null,
      couponCode: couponResult?.coupon.code || "",
      couponName: couponResult?.coupon.name || "",
      taxRate,
      taxMode,
      tax,
      netSales,
      total,
      totalCost,
      currency: business.currency,
      paymentMethod: input.data.paymentMethod,
      paymentMethodName: String(selectedPayment.name),
      paymentKind: selectedPayment.kind === "CASH" ? "CASH" : "NON_CASH",
      paymentAccountCode: String(selectedPayment.accountCode),
      paymentAccountName: String(selectedPayment.accountName),
      paymentVerificationMode: verificationMode,
      paymentProvider: provider,
      paymentIntentId: paymentIntent?._id || null,
      paymentReference: paymentIntent?.externalReference || input.data.paymentReference,
      paymentReferenceNormalized: verificationMode === "STATIC_QR" ? input.data.paymentReference.normalize("NFKC").trim().toUpperCase() : null,
      manualPaymentConfirmed: verificationMode === "STATIC_QR" ? true : null,
      manualPaymentConfirmedAt: verificationMode === "STATIC_QR" ? now : null,
      tenderCurrency,
      tenderTotal,
      exchangeRate: exchange.rate,
      exchangeRateSource: exchange.source,
      exchangeRateEffectiveAt: exchange.effectiveAt,
      tenderedAmount,
      changeDue,
      saleNote: input.data.saleNote,
      templateId: selectedTemplate?._id || null,
      templateName: templateSnapshot.name,
      templateSnapshot,
      businessSnapshot: {
        businessName: business.businessName,
        legalEntityName: business.legalEntityName,
        registrationNo: business.registrationNo,
        email: business.email,
        phone: business.phone,
        address: business.address,
        countryCode: business.countryCode,
        timeZone: business.timeZone,
        locale: business.locale,
        currency: business.currency,
        taxName: business.taxName,
        organizationType: business.organizationType,
        franchiseBrand: business.franchiseBrand,
        franchiseCode: business.franchiseCode,
      },
      status: "COMPLETED",
      createdBy: new ObjectId(auth.session.id),
      cashierName: auth.session.fullName,
      createdAt: now,
    };

    const client = await getMongoClient();
    const mongoSession = client.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        const paymentStillActive = await db.collection("paymentMethods").findOne({ _id: selectedPayment._id, active: { $ne: false }, updatedAt: selectedPayment.updatedAt }, { session: mongoSession });
        if (!paymentStillActive) throw new PaymentError("The payment method became unavailable before checkout. Choose another method.");
        if (verificationMode === "PROVIDER") {
          const consumed = await db.collection("paymentIntents").updateOne(
            {
              _id: paymentIntent!._id,
              createdBy: new ObjectId(auth.session.id),
              status: "VERIFIED",
              consumedAt: { $exists: false },
              expiresAt: { $gt: now },
              paymentMethod: selectedPayment.code,
              baseCurrency: business.currency,
              tenderCurrency,
            },
            { $set: { status: "CONSUMED", consumedAt: now, consumedBySaleId: saleId, updatedAt: now } },
            { session: mongoSession },
          );
          if (!consumed.modifiedCount) throw new PaymentError("The verified payment was already used or expired. Do not release the order.");
        }
        if (couponResult) {
          const refreshed = await validateCoupon(db, couponResult.coupon.code, subtotal, member?._id.toHexString() || null, mongoSession);
          if (!refreshed || refreshed.discount !== couponDiscount) throw new CouponError("The coupon changed before checkout. Review the order and try again.");
          const claimed = await db.collection("coupons").updateOne(
            {
              _id: couponResult.coupon._id,
              active: true,
              archivedAt: { $exists: false },
              $or: [
                { usageLimit: 0 },
                { usageLimit: { $exists: false } },
                { $expr: { $lt: [{ $ifNull: ["$usageCount", 0] }, "$usageLimit"] } },
              ],
            },
            { $inc: { usageCount: 1 }, $set: { lastUsedAt: now, updatedAt: now } },
            { session: mongoSession },
          );
          if (!claimed.modifiedCount) throw new CouponError("That coupon has just reached its usage limit.");
          await db.collection("couponRedemptions").insertOne({
            couponId: couponResult.coupon._id,
            couponCode: couponResult.coupon.code,
            saleId,
            memberId: member?._id || null,
            discount: couponDiscount,
            redeemedBy: new ObjectId(auth.session.id),
            createdAt: now,
          }, { session: mongoSession });
        }
        for (const item of items) {
          const updated = await db.collection("products").findOneAndUpdate(
            { _id: item.productId, active: { $ne: false }, stock: { $gte: item.quantity } },
            { $inc: { stock: -item.quantity }, $set: { updatedAt: now } },
            { returnDocument: "after", session: mongoSession },
          );
          if (!updated) throw new StockError(`${item.name} does not have enough stock.`);
          await db.collection("stockMovements").insertOne({
            productId: item.productId,
            sku: item.sku,
            productName: item.name,
            quantity: -item.quantity,
            type: "SALE",
            reason: receiptNo,
            referenceId: saleId,
            createdBy: new ObjectId(auth.session.id),
            createdAt: now,
          }, { session: mongoSession });
        }
        await db.collection("sales").insertOne(sale, { session: mongoSession });
        if (member) {
          await db.collection("members").updateOne(
            { _id: member._id },
            { $inc: { points: pointsEarned, lifetimeSpend: total }, $set: { lastVisitAt: now, updatedAt: now } },
            { session: mongoSession },
          );
        }
        const paymentAccount = [String(selectedPayment.accountCode), String(selectedPayment.accountName)];
        const revenueLines = [
          { accountCode: "4000", accountName: "Product sales", debit: 0, credit: netSales },
          ...(tax > 0 ? [{ accountCode: "2100", accountName: "GST payable", debit: 0, credit: tax }] : []),
        ];
        await db.collection("journalEntries").insertOne({
          entryNo: journalNo,
          date: now,
          memo: `POS sale ${receiptNo}`,
          reference: receiptNo,
          source: "POS",
          status: "POSTED",
          lines: [
            { accountCode: paymentAccount[0], accountName: paymentAccount[1], debit: total, credit: 0 },
            ...revenueLines,
            { accountCode: "5000", accountName: "Cost of goods sold", debit: totalCost, credit: 0 },
            { accountCode: "1200", accountName: "Inventory", debit: 0, credit: totalCost },
          ],
          totalDebit: asMoney(total + totalCost),
          totalCredit: asMoney(total + totalCost),
          createdBy: new ObjectId(auth.session.id),
          createdAt: now,
        }, { session: mongoSession });
        await writeAudit(db, auth.session, "sale.complete", "sale", saleId.toHexString(), { receiptNo, total, currency: business.currency, tenderCurrency, tenderTotal, exchangeRate: exchange.rate, verificationMode, manualPaymentConfirmed: verificationMode === "STATIC_QR", itemCount: items.length, couponCode: couponResult?.coupon.code || "", manualDiscount }, mongoSession);
      });
    } finally {
      await mongoSession.endSession();
    }
    return created(serialise(sale));
  } catch (error) {
    if (error instanceof StockError || error instanceof CouponError || error instanceof PaymentError) return fail(error.message, 409);
    if ((error as { code?: number; keyPattern?: Record<string, number> }).code === 11000 && (error as { keyPattern?: Record<string, number> }).keyPattern?.paymentReferenceNormalized) return fail("This static QR transaction reference was already used. Verify the receiving account and enter the reference for this payment.", 409);
    if ((error as { code?: number }).code === 11000 && clientRequestId) {
      const db = await getDb();
      const existing = await db.collection("sales").findOne({ clientRequestId, createdBy: new ObjectId(auth.session.id) });
      if (existing) return ok(serialise(existing));
      return fail("The receipt number collided. Please submit the sale again.", 409);
    }
    return publicError(error);
  }
}
