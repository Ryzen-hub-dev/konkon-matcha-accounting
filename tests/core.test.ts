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
  invoiceTemplateInputSchema,
  normaliseInvoiceTemplate,
} from "../lib/invoice-templates";
import {
  DEFAULT_RECEIPT_TEMPLATE,
  normaliseReceiptTemplate,
  receiptTemplateInputSchema,
} from "../lib/receipt-templates";
import { calculateTaxTotals } from "../lib/tax";
import { computeCouponDiscount } from "../lib/coupons";
import { createScannerToken, normaliseScanCode, scannerTokenHash } from "../lib/scanner";
import { normalisePrivateIdentifier, privateIdentifierHash } from "../lib/sensitive";
import { isWritePermission } from "../lib/system-control";
import { DEFAULT_PAYMENT_METHODS, paymentMethodSchema, paymentMethodUpdateSchema } from "../lib/payment-methods";
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
  verificationCodeHash, verifyPaymentWebhook,
} from "../lib/payment-verification";
import { locationParentChainIsValid } from "../lib/locations";

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
});

test("custom payment methods preserve trusted tender and ledger rules", () => {
  assert.equal(DEFAULT_PAYMENT_METHODS.length, 3);
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

test("provider verification codes are hashed and exact amounts must match", () => {
  assert.equal(normaliseVerificationCode(" pay-123 "), "PAY-123");
  assert.notEqual(verificationCodeHash("PAY-123"), "PAY-123");
  assert.equal(verificationCodeHash("pay-123"), verificationCodeHash(" PAY-123 "));
  assert.equal(paymentAmountsMatch(42.5, 42.50, "MYR"), true);
  assert.equal(paymentAmountsMatch(42.5, 42.49, "MYR"), false);
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

test("invoice templates accept portable JSON and safe raster logos", () => {
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
