import assert from "node:assert/strict";

const baseUrl = process.argv[2] || "http://localhost:3001";
let cookie = "";

async function request(path, options = {}, expectedStatus) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      origin: baseUrl,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const body = await response.json();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(body)}`);
  else assert.equal(response.ok, true, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return { response, body };
}

const setupState = await request("/api/setup");
assert.equal(setupState.body.data.configured, false, "Smoke tests require an isolated empty database namespace.");

await request("/api/setup", {
  method: "POST",
  body: JSON.stringify({
    businessName: "Codex isolated integration test",
    fullName: "Integration Owner",
    username: `integration_${Date.now()}`,
    email: `integration_${Date.now()}@example.test`,
    password: "CodexIntegration123!",
    seedProducts: false,
  }),
});

const productResponse = await request("/api/products", {
  method: "POST",
  body: JSON.stringify({
    sku: "IT-MATCHA-01",
    barcode: "9555000000012",
    name: "Integration Matcha",
    category: "Matcha powder",
    unit: "tin",
    price: 10,
    cost: 4,
    stock: 5,
    reorderLevel: 1,
  }),
});
const product = productResponse.body.data;
assert.equal(product.barcode, "9555000000012");

const settingsResponse = await request("/api/settings");
assert.equal(settingsResponse.body.data.currency, "SGD");
assert.equal(settingsResponse.body.data.timeZone, "Asia/Singapore");
await request("/api/settings/history");
const locationsResponse = await request("/api/locations");
assert.ok(locationsResponse.body.data.some((location) => location.systemKey === "HEADQUARTERS"));
await request("/api/members?revision=1");
await request("/api/exchange-rates");

const couponCode = `IT${Date.now()}`;
const couponResponse = await request("/api/coupons", {
  method: "POST",
  body: JSON.stringify({
    code: couponCode,
    name: "Integration ten percent",
    type: "PERCENT",
    value: 10,
    minSpend: 0,
    usageLimit: 2,
    perMemberLimit: 0,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    active: true,
  }),
});
assert.equal(couponResponse.body.data.code, couponCode);
const validatedCoupon = await request(`/api/coupons?code=${couponCode}&subtotal=10&memberId=`);
assert.equal(validatedCoupon.body.data.discount, 1);

const scannerResponse = await request("/api/scanner-sessions", {
  method: "POST",
  body: JSON.stringify({ label: "Integration phone", purpose: "POS" }),
});
const scannerSession = scannerResponse.body.data.session;
const scannerToken = new URL(scannerResponse.body.data.url).pathname.split("/").pop();
const routedScanner = await request("/api/scanner-sessions", {
  method: "PATCH",
  body: JSON.stringify({ id: scannerSession._id, purpose: "INVENTORY" }),
});
assert.equal(routedScanner.body.data.purpose, "INVENTORY");

const scanResponse = await request("/api/mobile-scans", {
  method: "POST",
  body: JSON.stringify({ token: scannerToken, code: "9555000000099" }),
});
assert.equal(scanResponse.body.data.purpose, "INVENTORY");
await request(`/api/mobile-scans?sessionId=${scannerSession._id}&consumerId=integration-consumer-pos&purpose=POS`, {}, 410);
const inventoryEvents = await request(`/api/mobile-scans?sessionId=${scannerSession._id}&consumerId=integration-consumer-inventory&purpose=INVENTORY`);
assert.deepEqual(inventoryEvents.body.data.map((event) => event.code), ["9555000000099"]);
await request("/api/mobile-scans", {
  method: "PATCH",
  body: JSON.stringify({
    sessionId: scannerSession._id,
    consumerId: "integration-consumer-inventory",
    eventIds: inventoryEvents.body.data.map((event) => event._id),
  }),
});

const stocktakeResponse = await request("/api/stocktakes", {
  method: "POST",
  body: JSON.stringify({ note: "Integration physical count", lines: [{ productId: product._id, countedStock: 3 }] }),
});
assert.equal(stocktakeResponse.body.data.adjustedLineCount, 1);
assert.equal(stocktakeResponse.body.data.absoluteVariance, 2);
assert.equal(stocktakeResponse.body.data.lines[0].difference, -2);

const [{ body: templateBody }, { body: paymentBody }] = await Promise.all([
  request("/api/receipt-templates"),
  request("/api/payment-methods"),
]);
const template = templateBody.data.templates.find((item) => item.isDefault) || templateBody.data.templates[0];
const payment = paymentBody.data.find((item) => item.code === "CASH" && item.active !== false);
const providerPayment = paymentBody.data.find((item) => item.verificationMode === "PROVIDER" && item.active !== false);
assert.ok(template?._id);
assert.ok(payment?.code);

if (providerPayment) {
  await request("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      memberId: null,
      paymentMethod: providerPayment.code,
      paymentReference: "UNVERIFIED",
      tenderCurrency: providerPayment.supportedCurrencies?.[0] || "SGD",
      paymentIntentId: "",
      templateId: template._id,
      items: [{ productId: product._id, quantity: 1 }],
    }),
  }, 422);
  const unchangedProduct = await request("/api/products?barcode=9555000000012");
  assert.equal(unchangedProduct.body.data[0].stock, 3, "Unverified provider payment changed stock.");
}

const saleResponse = await request("/api/sales", {
  method: "POST",
  body: JSON.stringify({
    clientRequestId: crypto.randomUUID(),
    memberId: null,
    paymentMethod: payment.code,
    paymentReference: payment.referenceRequired ? "IT-APPROVAL-1" : "",
    tenderedAmount: 100,
    templateId: template._id,
    saleNote: "Integration smoke test",
    manualDiscount: 0,
    couponCode,
    items: [{ productId: product._id, quantity: 1 }],
  }),
});
assert.equal(saleResponse.body.data.couponCode, couponCode);
assert.equal(saleResponse.body.data.couponDiscount, 1);
assert.equal(saleResponse.body.data.total, 9);

const finalProduct = await request("/api/products?barcode=9555000000012");
assert.equal(finalProduct.body.data[0].stock, 2);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "product barcode persisted",
    "coupon created and validated",
    "scanner rerouted from POS to Inventory",
    "inventory-only scan delivery",
    "stocktake variance posted",
    "unverified provider sale blocked before stock mutation",
    "coupon checkout completed",
    "stock decremented after sale",
  ],
  stocktakeNo: stocktakeResponse.body.data.stocktakeNo,
  receiptNo: saleResponse.body.data.receiptNo,
}, null, 2));
