import assert from "node:assert/strict";
import test from "node:test";
import { asMoney, makeDocumentNo } from "../lib/format";
import { canManageRole, hasPermission } from "../lib/rbac";
import { POST as login } from "../app/api/auth/login/route";
import { POST as setup } from "../app/api/setup/route";
import { publicError } from "../lib/api";
import { scopedCollectionName } from "../lib/db";
import {
  DEFAULT_INVOICE_TEMPLATE,
  ensureDefaultInvoiceTemplate,
  invoiceTemplateInputSchema,
  normaliseInvoiceTemplate,
} from "../lib/invoice-templates";
import {
  DEFAULT_RECEIPT_TEMPLATE,
  ensureDefaultReceiptTemplate,
  normaliseReceiptTemplate,
  receiptTemplateInputSchema,
} from "../lib/receipt-templates";
import { calculateTaxTotals } from "../lib/tax";
import { computeCouponDiscount } from "../lib/coupons";
import { createScannerToken, normaliseScanCode, scannerTokenHash } from "../lib/scanner";
import { normalisePrivateIdentifier, privateIdentifierHash } from "../lib/sensitive";
import { isWritePermission } from "../lib/system-control";
import { DEFAULT_PAYMENT_METHODS, ensureDefaultPaymentMethods, paymentMethodSchema, paymentMethodUpdateSchema } from "../lib/payment-methods";
import { localDateTimeToUtcIso } from "../lib/dates";
import { stocktakeDifference, stocktakeInputSchema } from "../lib/stocktake";
import { scannerActivityAt, scannerPurposeFilter, selectScannerSession } from "../lib/scanner-routing";
import {
  convertCurrency, countryProfile, currencyMinorUnits, isValidCurrency,
  isValidTimeZone, roundCurrency,
} from "../lib/international";
import { clearPosDraft, posDraftStorageKey, readPosDraft, savePosDraft, type PosDraft } from "../lib/pos-draft";
import {
  normaliseVerificationCode, paymentAmountsMatch, signPaymentWebhook,
  staticQrPaymentIsConfirmed, verificationCodeHash, verifyPaymentWebhook,
} from "../lib/payment-verification";
import { locationParentChainIsValid } from "../lib/locations";
import {
  allocateSupplierPayment, approvalRequiresDifferentMaker, purchaseOrderInputSchema,
  suggestedReorderAfterInbound, suggestedReorderQuantity, supplierInputSchema,
  supplierPulse, weightedAverageInventoryCost,
} from "../lib/procurement";
import { dateKeyInTimeZone } from "../lib/dates";
import { assembleFinancialStatements, buildAgingReport } from "../lib/financial-reports";
import {
  localPaymentEventSchema, normaliseLocalBridgePath, parseLocalPaymentNotification,
  signSmsForwarderWebhook, verifySmsForwarderWebhook,
} from "../lib/local-payment-bridge";
import { buildAmountLockedDuitNowQr, inspectDuitNowQr } from "../lib/duitnow-qr";
import { createPaymentDisplayToken, paymentDisplayTokenHash } from "../lib/payment-display";

function sameOriginRequest(path: string, body: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost" },
    body,
  });
}

test("money values are rounded to accounting precision", () => {
  assert.equal(asMoney(10.005), 10.01);
  assert.equal(asMoney("46.90"), 46.9);
  assert.equal(asMoney("not-a-number"), 0);
});

test("document numbers are recognisable and collision resistant", () => {
  const first = makeDocumentNo("INV");
  const second = makeDocumentNo("INV");
  assert.match(first, /^INV-\d{8}-[A-F0-9]{6}$/);
  assert.notEqual(first, second);
});

test("cashier permissions stop at the counter", () => {
  assert.equal(hasPermission("CASHIER", "pos.sell"), true);
  assert.equal(hasPermission("CASHIER", "payments.read"), true);
  assert.equal(hasPermission("CASHIER", "payments.manage"), false);
  assert.equal(hasPermission("CASHIER", "coupons.read"), true);
  assert.equal(hasPermission("CASHIER", "coupons.manage"), false);
  assert.equal(hasPermission("CASHIER", "receipts.read"), true);
  assert.equal(hasPermission("CASHIER", "receipts.manage"), false);
  assert.equal(hasPermission("CASHIER", "accounting.write"), false);
  assert.equal(hasPermission("CASHIER", "team.write"), false);
  assert.equal(hasPermission("MANAGER", "purchasing.approve"), true);
  assert.equal(hasPermission("MANAGER", "payables.write"), false);
  assert.equal(hasPermission("ACCOUNTANT", "payables.write"), true);
});

test("custom payment methods preserve trusted tender and ledger rules", () => {
  assert.equal(DEFAULT_PAYMENT_METHODS.length, 4);
  assert.equal(DEFAULT_PAYMENT_METHODS.find((method) => method.systemKey === "TNG")?.active, false);
  const wallet = paymentMethodSchema.safeParse({ code: " grab-pay ", name: "GrabPay", kind: "NON_CASH", accountCode: "1010", referenceRequired: true, sortOrder: "40" });
  assert.equal(wallet.success, true);
  if (wallet.success) {
    assert.equal(wallet.data.code, "GRAB-PAY");
    assert.equal(wallet.data.referenceRequired, true);
    assert.equal(wallet.data.sortOrder, 40);
  }
  assert.equal(paymentMethodSchema.safeParse({ code: "!", name: "X", kind: "CRYPTO", accountCode: "9999" }).success, false);
  const archiveOnly = paymentMethodUpdateSchema.safeParse({ id: "a".repeat(24), active: false });
  assert.equal(archiveOnly.success, true);
  assert.equal(paymentMethodSchema.safeParse({ code: "DUITNOW", name: "DuitNow QR", kind: "NON_CASH", accountCode: "1010", verificationMode: "STATIC_QR", providerCode: "DUITNOW", qrPayload: "" }).success, false);
  assert.equal(paymentMethodSchema.safeParse({ code: "DUITNOW", name: "DuitNow QR", kind: "NON_CASH", accountCode: "1010", verificationMode: "STATIC_QR", providerCode: "DUITNOW", qrPayload: "00020101021126580010MY.DUITNOW" }).success, true);
});

test("default payment seeding adopts an existing code instead of creating a duplicate", async () => {
  let operations: Array<{ updateOne: { filter: unknown; upsert?: boolean } }> = [];
  const db = { collection: () => ({ bulkWrite: async (value: typeof operations) => { operations = value; } }) };
  await ensureDefaultPaymentMethods(db as never);
  assert.equal(operations.length, DEFAULT_PAYMENT_METHODS.length);
  assert.deepEqual(operations.find((operation) => JSON.stringify(operation.updateOne.filter).includes('"TNG"'))?.updateOne.filter, { $or: [{ systemKey: "TNG" }, { code: "TNG" }] });
  assert.equal(operations.every((operation) => operation.updateOne.upsert === true), true);
});

test("financial statements reconcile posted movements across all core reports", () => {
  const report = assembleFinancialStatements({
    currency: "SGD",
    accounts: [
      { code: "1000", name: "Cash", type: "ASSET", cashEquivalent: true },
      { code: "1200", name: "Inventory", type: "ASSET" },
      { code: "2100", name: "GST payable", type: "LIABILITY" },
      { code: "3000", name: "Equity", type: "EQUITY" },
      { code: "4000", name: "Sales", type: "REVENUE" },
      { code: "5000", name: "Cost of goods sold", type: "EXPENSE" },
    ],
    movements: [
      { code: "1000", periodDebit: 109 },
      { code: "1200", periodCredit: 40 },
      { code: "2100", periodCredit: 9 },
      { code: "4000", periodCredit: 100 },
      { code: "5000", periodDebit: 40 },
    ],
    cashMovements: [{ source: "POS", periodAmount: 109 }],
  });
  assert.equal(report.profitAndLoss.grossProfit, 60);
  assert.equal(report.profitAndLoss.netProfit, 60);
  assert.equal(report.balanceSheet.totalAssets, 69);
  assert.equal(report.balanceSheet.totalLiabilities, 9);
  assert.equal(report.balanceSheet.totalEquity, 60);
  assert.equal(report.cashFlow.closingCash, 109);
  assert.equal(report.tax.netMovement, 9);
  assert.equal(report.trialBalance.periodDifference, 0);
  assert.equal(report.integrity.balanced, true);
});

test("AR and AP aging place balances in mutually exclusive due-date buckets", () => {
  const aging = buildAgingReport([
    { id: "1", documentNo: "INV-1", party: "Current", dueDate: "2026-09-05", balance: 10 },
    { id: "2", documentNo: "INV-2", party: "Recent", dueDate: "2026-08-16", balance: 20 },
    { id: "3", documentNo: "INV-3", party: "Older", dueDate: "2026-07-16", balance: 30 },
    { id: "4", documentNo: "INV-4", party: "Oldest", dueDate: "2026-05-31", balance: 40 },
  ], "2026-08-31", "SGD");
  assert.equal(aging.total, 100);
  assert.equal(aging.buckets.find((bucket) => bucket.key === "CURRENT")?.amount, 10);
  assert.equal(aging.buckets.find((bucket) => bucket.key === "1_30")?.amount, 20);
  assert.equal(aging.buckets.find((bucket) => bucket.key === "31_60")?.amount, 30);
  assert.equal(aging.buckets.find((bucket) => bucket.key === "OVER_90")?.amount, 40);
  assert.equal(aging.rows.length, 4);
});

test("country profiles use valid ISO currencies and IANA time zones", () => {
  const malaysia = countryProfile("MY");
  assert.equal(malaysia.currency, "MYR");
  assert.equal(malaysia.timeZone, "Asia/Kuala_Lumpur");
  assert.equal(isValidCurrency("CNY"), true);
  assert.equal(isValidCurrency("RMB"), false);
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("Singapore time"), false);
});

test("cross-border conversion respects each currency's minor units", () => {
  assert.equal(convertCurrency(100, 5.42, "CNY"), 542);
  assert.equal(roundCurrency(100.6, "JPY"), 101);
  assert.equal(roundCurrency(1.2346, "KWD"), 1.235);
  assert.equal(currencyMinorUnits(1.235, "KWD"), 1235);
});

test("procurement masters and orders reject invalid or duplicate product data", () => {
  assert.equal(supplierInputSchema.safeParse({ code: "uji_01", name: "Uji Tea Cooperative", countryCode: "JP", currency: "JPY" }).success, true);
  assert.equal(supplierInputSchema.safeParse({ code: "!", name: "X", countryCode: "XX", currency: "RMB" }).success, false);
  const item = { productId: "a".repeat(24), quantity: 10, unitCost: 12.5 };
  const base = { clientRequestId: "11111111-1111-4111-8111-111111111111", supplierId: "b".repeat(24), locationId: "c".repeat(24), expectedDate: "2026-09-01", items: [item] };
  assert.equal(purchaseOrderInputSchema.safeParse(base).success, true);
  assert.equal(purchaseOrderInputSchema.safeParse({ ...base, items: [item, item] }).success, false);
  assert.equal(purchaseOrderInputSchema.safeParse({ ...base, items: [{ ...item, unitCost: 0 }] }).success, false);
});

test("smart replenishment combines thresholds, demand and supplier lead time", () => {
  assert.equal(suggestedReorderQuantity(4, 5), 6);
  assert.equal(suggestedReorderQuantity(4, 5, 60, 14), 29);
  assert.equal(suggestedReorderQuantity(6, 5, 600, 30), 0);
  assert.equal(suggestedReorderAfterInbound(4, 5, 60, 14, 20), 9);
  assert.equal(suggestedReorderAfterInbound(4, 5, 60, 14, 29), 0);
});

test("purchase controls use business dates and maker-checker approval", () => {
  assert.equal(dateKeyInTimeZone("2026-08-22T01:00:00.000Z", "America/New_York"), "2026-08-21");
  assert.equal(dateKeyInTimeZone("2026-08-22T01:00:00.000Z", "Asia/Singapore"), "2026-08-22");
  assert.equal(approvalRequiresDifferentMaker("MANAGER"), true);
  assert.equal(approvalRequiresDifferentMaker("ADMIN"), true);
  assert.equal(approvalRequiresDifferentMaker("OWNER"), false);
});

test("supplier Supply Pulse is deterministic and explains delivery risk", () => {
  assert.deepEqual(supplierPulse({ receiptCount: 10, onTimeReceiptCount: 10, lateDaysTotal: 0, overdueOrderCount: 0 }), { score: 100, risk: "STABLE", punctuality: 100, averageLateDays: 0 });
  const risk = supplierPulse({ receiptCount: 10, onTimeReceiptCount: 4, lateDaysTotal: 30, overdueOrderCount: 2 });
  assert.equal(risk.risk, "AT_RISK");
  assert.equal(risk.punctuality, 40);
  assert.equal(risk.averageLateDays, 3);
});

test("receiving uses weighted inventory cost and AP settlement balances FX", () => {
  assert.equal(weightedAverageInventoryCost(10, 5, 5, 40, "SGD"), 6);
  const loss = allocateSupplierPayment({ total: 500, baseTotal: 100, balance: 500, baseBalance: 100, amount: 250, exchangeRate: 4.8, currency: "MYR", baseCurrency: "SGD" });
  assert.deepEqual(loss, { amount: 250, finalPayment: false, carryingBaseAmount: 50, baseCashAmount: 52.08, exchangeLoss: 2.08, exchangeGain: 0 });
  const gain = allocateSupplierPayment({ total: 500, baseTotal: 100, balance: 250, baseBalance: 50, amount: 250, exchangeRate: 5.2, currency: "MYR", baseCurrency: "SGD" });
  assert.deepEqual(gain, { amount: 250, finalPayment: true, carryingBaseAmount: 50, baseCashAmount: 48.08, exchangeLoss: 0, exchangeGain: 1.92 });
});

test("location hierarchies reject self, descendant and corrupt parent cycles", async () => {
  const parents = new Map<string, string | null>([["hq", null], ["region", "hq"], ["shop", "region"]]);
  const read = async (id: string) => parents.get(id);
  assert.equal(await locationParentChainIsValid("region", "new-shop", read), true);
  assert.equal(await locationParentChainIsValid("shop", "region", read), false);
  assert.equal(await locationParentChainIsValid("shop", "shop", read), false);
  parents.set("hq", "shop");
  assert.equal(await locationParentChainIsValid("region", "another-shop", read), false);
  assert.equal(await locationParentChainIsValid("missing", "another-shop", read), false);
});

test("payment webhooks require a fresh untampered HMAC signature", () => {
  const secret = "test-payment-webhook-secret-at-least-32-characters";
  const rawBody = JSON.stringify({ provider: "TNG", amount: 42.5, currency: "MYR" });
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const signature = signPaymentWebhook(rawBody, timestamp, secret);
  assert.equal(verifyPaymentWebhook(rawBody, timestamp, signature, secret, now), true);
  assert.equal(verifyPaymentWebhook(`${rawBody} `, timestamp, signature, secret, now), false);
  assert.equal(verifyPaymentWebhook(rawBody, String(Math.floor((now - 6 * 60_000) / 1000)), signature, secret, now), false);
});

test("local SMS bridge signatures are fresh and compatible with signed forwarding", () => {
  const secret = "local-bridge-test-secret-at-least-16";
  const now = Date.now();
  const timestamp = String(now);
  const signature = signSmsForwarderWebhook(timestamp, secret);
  assert.equal(verifySmsForwarderWebhook(timestamp, signature, secret, now), true);
  assert.equal(verifySmsForwarderWebhook(timestamp, `${signature}x`, secret, now), false);
  assert.equal(verifySmsForwarderWebhook(String(now - 6 * 60_000), signSmsForwarderWebhook(String(now - 6 * 60_000), secret), secret, now), false);
});

test("local payment bridge accepts adapter-added trailing slashes without broadening paths", () => {
  assert.equal(normaliseLocalBridgePath("/notify-me/"), "/notify-me");
  assert.equal(normaliseLocalBridgePath("/sms///"), "/sms");
  assert.equal(normaliseLocalBridgePath("/notify-me/extra"), "/notify-me/extra");
  assert.equal(normaliseLocalBridgePath("/"), "/");
});

test("DuitNow amount locking preserves the recipient, inserts the POS total and recalculates CRC", () => {
  const officialPayNetP2pExample = "00020201021126410014A000000615000101065016640209123456789520400005303458540510.005802MY5909AUSERNAME6005BANGI63043A23";
  const generated = buildAmountLockedDuitNowQr(officialPayNetP2pExample, 42.5, "MYR");
  const inspection = inspectDuitNowQr(generated.payload);
  assert.equal(generated.amount, "42.50");
  assert.equal(generated.amountLocked, true);
  assert.equal(generated.pointOfInitiation, "STATIC");
  assert.equal(inspection.amount, "42.50");
  assert.equal(inspection.recipientType, "P2P");
  assert.equal(inspection.crcValid, true);
  assert.match(generated.payload, /0014A0000006150001/);
  assert.throws(() => buildAmountLockedDuitNowQr(officialPayNetP2pExample, 42.5, "SGD"), /MYR/);
  assert.throws(() => buildAmountLockedDuitNowQr(`${officialPayNetP2pExample.slice(0, -1)}0`, 42.5, "MYR"), /checksum/i);
});

test("payment display passes use unguessable hashed tokens", () => {
  const token = createPaymentDisplayToken();
  assert.match(token, /^[A-Za-z0-9_-]{32,128}$/);
  assert.notEqual(paymentDisplayTokenHash(token), token);
  assert.equal(paymentDisplayTokenHash(token), paymentDisplayTokenHash(token));
});

test("local payment notifications are sanitised before leaving the computer", () => {
  const result = parseLocalPaymentNotification({
    sender: "TNG",
    content: "Payment received. RM 42.50 credited to wallet **7788. Transaction ID TNG-48291",
    timestamp: Date.parse("2026-08-25T10:00:00.000Z"),
  }, { secret: "local-bridge-test-secret-at-least-16", allowedSenders: ["TNG"] });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.event.provider, "TNG");
  assert.equal(result.event.amount, 42.5);
  assert.equal(result.event.currency, "MYR");
  assert.equal(result.event.externalReference, "TNG-48291");
  assert.equal(result.event.recipientAccountMasked, "**7788");
  assert.equal("content" in result.event, false);
  assert.equal("sender" in result.event, false);
  assert.equal(localPaymentEventSchema.safeParse({ ...result.event, content: "must never reach MongoDB" }).success, false);
});

test("local payment notifications accept epoch seconds and normalise them to milliseconds", () => {
  const paidAt = Math.floor(Date.now() / 1_000);
  const parsed = parseLocalPaymentNotification({
    sender: "PAYNOW",
    content: "PayNow payment received SGD 12.30 ref: PN-778899",
    timestamp: paidAt,
  }, { secret: "local-payment-test-secret" });
  assert.equal(parsed.accepted, true);
  if (parsed.accepted) assert.equal(parsed.event.paidAt.getTime(), paidAt * 1_000);
});

test("local payment privacy gate rejects OTP, outgoing and unrelated messages", () => {
  const options = { secret: "local-bridge-test-secret-at-least-16" };
  const base = { sender: "BANK", timestamp: Date.now() };
  assert.deepEqual(parseLocalPaymentNotification({ ...base, content: "Your OTP is 123456 for RM 20.00 payment" }, options), { accepted: false, reason: "PRIVACY_BLOCKED" });
  assert.deepEqual(parseLocalPaymentNotification({ ...base, content: "You paid RM 20.00 to SHOP" }, options), { accepted: false, reason: "OUTGOING_PAYMENT" });
  assert.deepEqual(parseLocalPaymentNotification({ ...base, content: "Your monthly statement is ready" }, options), { accepted: false, reason: "NOT_PAYMENT" });
  assert.deepEqual(parseLocalPaymentNotification({ ...base, content: "Payment received from customer" }, options), { accepted: false, reason: "AMOUNT_MISSING" });
});

test("local payment sender allow-lists block unapproved message sources", () => {
  const result = parseLocalPaymentNotification({ sender: "UNKNOWN", content: "Payment received SGD 18.00 Ref SG-8822", timestamp: Date.now() }, {
    secret: "local-bridge-test-secret-at-least-16",
    allowedSenders: ["DBS", "PAYNOW"],
  });
  assert.deepEqual(result, { accepted: false, reason: "SENDER_NOT_ALLOWED" });
});

test("provider verification codes are hashed and exact amounts must match", () => {
  assert.equal(normaliseVerificationCode(" pay-123 "), "PAY-123");
  assert.notEqual(verificationCodeHash("PAY-123"), "PAY-123");
  assert.equal(verificationCodeHash("pay-123"), verificationCodeHash(" PAY-123 "));
  assert.equal(paymentAmountsMatch(42.5, 42.50, "MYR"), true);
  assert.equal(paymentAmountsMatch(42.5, 42.49, "MYR"), false);
});

test("static recipient QR never counts as paid without a receiving-side check and reference", () => {
  assert.equal(staticQrPaymentIsConfirmed("TNG-48291", true), true);
  assert.equal(staticQrPaymentIsConfirmed("TNG-48291", false), false);
  assert.equal(staticQrPaymentIsConfirmed("123", true), false);
  assert.equal(staticQrPaymentIsConfirmed("", true), false);
});

test("POS drafts survive refresh, keep bounded history and clear only the active order", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) || null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  };
  const key = posDraftStorageKey("cashier-1");
  const first: PosDraft = {
    version: 1,
    draftId: "11111111-1111-4111-8111-111111111111",
    updatedAt: "2026-08-22T01:00:00.000Z",
    lines: [{ productId: "a".repeat(24), quantity: 2, sku: "SKU-1", name: "Tea", price: 10 }],
    memberId: "", paymentMethod: "CASH", tenderCurrency: "SGD", manualDiscount: 0,
    couponCode: "", saleNote: "", templateId: "",
  };
  savePosDraft(storage, key, first);
  assert.equal(readPosDraft(storage, key).active?.lines[0]?.quantity, 2);
  savePosDraft(storage, key, { ...first, updatedAt: "2026-08-22T01:01:00.000Z", lines: [{ ...first.lines[0], quantity: 3 }] });
  assert.equal(readPosDraft(storage, key).history.length, 1);
  clearPosDraft(storage, key);
  assert.equal(readPosDraft(storage, key).active, null);
  assert.equal(readPosDraft(storage, key).history.length, 1);
});

test("coupon discounts are bounded and calculated on the server model", () => {
  assert.equal(computeCouponDiscount({ type: "PERCENT", value: 15, minSpend: 20 }, 100), 15);
  assert.equal(computeCouponDiscount({ type: "FIXED", value: 500, minSpend: 0 }, 42.5), 42.5);
  assert.equal(computeCouponDiscount({ type: "FIXED", value: 10, minSpend: 50 }, 49.99), 0);
});

test("coupon date-time inputs preserve the operator's local time in UTC", () => {
  assert.equal(localDateTimeToUtcIso("2026-08-22T10:30", -480), "2026-08-22T02:30:00.000Z");
  assert.equal(localDateTimeToUtcIso("2026-08-22T02:30:00.000Z", -480), "2026-08-22T02:30:00.000Z");
  assert.throws(() => localDateTimeToUtcIso("not-a-date"), /valid date/i);
});

test("stocktakes calculate signed variance and reject duplicate product counts", () => {
  assert.equal(stocktakeDifference(12, 9), -3);
  assert.equal(stocktakeDifference(12, 15), 3);
  const productId = "a".repeat(24);
  assert.equal(stocktakeInputSchema.safeParse({ note: "Month end", lines: [{ productId, countedStock: "7" }] }).success, true);
  assert.equal(stocktakeInputSchema.safeParse({ lines: [{ productId, countedStock: 7 }, { productId, countedStock: 8 }] }).success, false);
});

test("scanner tokens are unguessable hashes and scan codes reject controls", () => {
  const token = createScannerToken();
  assert.ok(token.length >= 40);
  assert.notEqual(scannerTokenHash(token), token);
  assert.equal(scannerTokenHash(token), scannerTokenHash(token));
  assert.equal(normaliseScanCode("  ean-123  "), "EAN-123");
  assert.equal(normaliseScanCode("BAD\nCODE"), "");
});

test("scanner routing moves the most recently active pass to the current workflow", () => {
  const sessions = [
    { _id: "recent-pos", purpose: "POS" as const, createdAt: "2026-08-22T02:00:00.000Z", connectedAt: "2026-08-22T03:00:00.000Z" },
    { _id: "old-inventory", purpose: "INVENTORY" as const, createdAt: "2026-08-21T02:00:00.000Z" },
  ].sort((left, right) => scannerActivityAt(right) - scannerActivityAt(left));
  assert.equal(selectScannerSession(sessions, "INVENTORY")?._id, "recent-pos");
  assert.equal(selectScannerSession(sessions, "INVENTORY", "", "old-inventory")?._id, "old-inventory");
  assert.deepEqual(scannerPurposeFilter("INVENTORY"), { purpose: "INVENTORY" });
  assert.deepEqual(scannerPurposeFilter("POS"), { $or: [{ purpose: "POS" }, { purpose: { $exists: false } }] });
});

test("member identity lookups are normalised and keyed without storing plaintext", () => {
  const previousSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-only-auth-secret-with-at-least-32-characters";
  try {
    assert.equal(normalisePrivateIdentifier(" s-123 45 "), "S12345");
    const hash = privateIdentifierHash("S12345");
    assert.notEqual(hash, "S12345");
    assert.equal(hash, privateIdentifierHash(" s-123 45 "));
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
  }
});

test("system modes recognise every business mutation as a write", () => {
  assert.equal(isWritePermission("pos.sell"), true);
  assert.equal(isWritePermission("inventory.write"), true);
  assert.equal(isWritePermission("coupons.manage"), true);
  assert.equal(isWritePermission("payments.manage"), true);
  assert.equal(isWritePermission("reports.read"), false);
});

test("owner remains the only role that can manage administrators", () => {
  assert.equal(canManageRole("OWNER", "ADMIN"), true);
  assert.equal(canManageRole("ADMIN", "ADMIN"), false);
  assert.equal(canManageRole("ADMIN", "MANAGER"), true);
  assert.equal(canManageRole("OWNER", "OWNER"), false);
});

test("setup and login return JSON errors for malformed request bodies", async () => {
  const previousSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-only-auth-secret-with-at-least-32-characters";
  try {
    for (const [path, handler] of [["/api/setup", setup], ["/api/auth/login", login]] as const) {
      const response = await handler(sameOriginRequest(path, "{"));
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
      assert.equal(body.ok, false);
      assert.match(body.error, /valid JSON/i);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
  }
});

test("setup rejects invalid fields before touching the database", async () => {
  const previousSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-only-auth-secret-with-at-least-32-characters";
  try {
    const response = await setup(sameOriginRequest("/api/setup", JSON.stringify({ businessName: "x" })));
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.ok(body.issues.businessName);
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
  }
});

test("authentication endpoints reject cross-origin requests", async () => {
  const response = await login(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "https://attacker.example" },
    body: JSON.stringify({ identity: "owner", password: "password" }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "This request was blocked." });
});

test("database failures return actionable service errors", async () => {
  const unreachable = new Error("server selection timed out");
  unreachable.name = "MongoServerSelectionError";
  const response = publicError(unreachable);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /IP access list/i);

  const authentication = Object.assign(new Error("Authentication failed"), { code: 18 });
  const authResponse = publicError(authentication);
  assert.equal(authResponse.status, 503);
  assert.match((await authResponse.json()).error, /credentials/i);

  const stableApi = Object.assign(new Error("API strict error"), { code: 323 });
  const stableApiResponse = publicError(stableApi);
  assert.equal(stableApiResponse.status, 503);
  assert.match((await stableApiResponse.json()).error, /Stable API/i);
});

test("MongoDB collections use an isolated application namespace", () => {
  assert.equal(scopedCollectionName("users"), "konkon_users");
  assert.equal(scopedCollectionName("sales", "matcha_"), "matcha_sales");
  assert.throws(() => scopedCollectionName("users", "invalid prefix"), /invalid/i);
});

test("default template seeding never writes the same MongoDB path twice", async () => {
  const operations: Array<{ collection: string; update: Record<string, Record<string, unknown>> }> = [];
  const db = {
    collection(name: string) {
      return {
        async updateOne(_filter: unknown, update: Record<string, Record<string, unknown>>) {
          const setKeys = new Set(Object.keys(update.$set || {}));
          for (const key of Object.keys(update.$setOnInsert || {})) {
            assert.equal(setKeys.has(key), false, `${name}.${key} cannot appear in both $set and $setOnInsert`);
          }
          operations.push({ collection: name, update });
          return { acknowledged: true };
        },
      };
    },
  };
  await ensureDefaultInvoiceTemplate(db as never);
  await ensureDefaultReceiptTemplate(db as never);
  assert.equal(operations.length, 4);
  assert.deepEqual(operations.at(-1)?.update.$set, { showBusinessAddress: false });
});

test("invoice templates accept portable JSON and safe raster logos", () => {
  assert.equal(DEFAULT_INVOICE_TEMPLATE.showBusinessAddress, false);
  assert.equal(DEFAULT_INVOICE_TEMPLATE.showCustomerAddress, false);
  const imported = invoiceTemplateInputSchema.safeParse({
    ...DEFAULT_INVOICE_TEMPLATE,
    name: "Wholesale ledger",
    layout: "LEDGER",
    accentColor: "#69815d",
    logoDataUrl: "data:image/png;base64,aGVsbG8=",
    termsDays: "30",
  });
  assert.equal(imported.success, true);
  if (imported.success) {
    assert.equal(imported.data.termsDays, 30);
    assert.equal(imported.data.layout, "LEDGER");
  }
});

test("invoice templates reject SVG uploads and fall back safely for old invoices", () => {
  const unsafeLogo = invoiceTemplateInputSchema.safeParse({
    ...DEFAULT_INVOICE_TEMPLATE,
    logoDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  });
  assert.equal(unsafeLogo.success, false);

  const legacySnapshot = normaliseInvoiceTemplate({ layout: "UNKNOWN" });
  assert.deepEqual(legacySnapshot, DEFAULT_INVOICE_TEMPLATE);
});

test("receipt templates support 58mm and 80mm paper but reject active SVG content", () => {
  assert.equal(DEFAULT_RECEIPT_TEMPLATE.showBusinessAddress, false);
  const narrow = receiptTemplateInputSchema.safeParse({ ...DEFAULT_RECEIPT_TEMPLATE, name: "Market roll", paperWidth: "58MM" });
  assert.equal(narrow.success, true);
  const unsafeLogo = receiptTemplateInputSchema.safeParse({
    ...DEFAULT_RECEIPT_TEMPLATE,
    logoDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  });
  assert.equal(unsafeLogo.success, false);
  assert.deepEqual(normaliseReceiptTemplate({ paperWidth: "A4" }), DEFAULT_RECEIPT_TEMPLATE);
});

test("POS tax totals are identical for exclusive and tax-inclusive shelf prices", () => {
  const exclusive = calculateTaxTotals(100, 10, 9, "EXCLUSIVE");
  assert.deepEqual(exclusive, { subtotal: 100, discount: 10, discountedTotal: 90, taxRate: 9, taxMode: "EXCLUSIVE", tax: 8.1, netSales: 90, total: 98.1 });

  const inclusive = calculateTaxTotals(109, 0, 9, "INCLUSIVE");
  assert.deepEqual(inclusive, { subtotal: 109, discount: 0, discountedTotal: 109, taxRate: 9, taxMode: "INCLUSIVE", tax: 9, netSales: 100, total: 109 });
});
