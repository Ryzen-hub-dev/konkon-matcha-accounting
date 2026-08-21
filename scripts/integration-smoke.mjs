import assert from "node:assert/strict";

const baseUrl = process.argv[2] || "http://localhost:3001";
let cookie = "";

function dateKeyInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

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
const businessDate = dateKeyInTimeZone(new Date(), settingsResponse.body.data.timeZone);
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

const supplierCode = `ITSUP${Date.now()}`;
const supplierResponse = await request("/api/suppliers", {
  method: "POST",
  body: JSON.stringify({
    code: supplierCode,
    name: "Integration Tea Supplier",
    contactName: "Procurement Test",
    registrationNo: "IT-REG-1",
    taxNo: "IT-TAX-1",
    email: "supplier@example.test",
    phone: "+6500000000",
    address: "Integration warehouse",
    countryCode: "SG",
    currency: "SGD",
    paymentTermsDays: 30,
    leadTimeDays: 2,
    minimumOrder: 0,
    notes: "Isolated purchase-to-pay test",
  }),
});
const supplier = supplierResponse.body.data;
const location = locationsResponse.body.data.find((item) => item.systemKey === "HEADQUARTERS");
assert.ok(supplier._id && location?._id);

const orderRequest = {
  clientRequestId: crypto.randomUUID(),
  supplierId: supplier._id,
  locationId: location._id,
  expectedDate: businessDate,
  supplierReference: "IT-QUOTE-1",
  taxRate: 9,
  taxMode: "EXCLUSIVE",
  notes: "Integration replenishment",
  items: [{ productId: product._id, quantity: 2, unitCost: 4 }],
};
const purchaseOrderResponse = await request("/api/purchase-orders", { method: "POST", body: JSON.stringify(orderRequest) });
const purchaseOrder = purchaseOrderResponse.body.data;
assert.equal(purchaseOrder.status, "DRAFT");
const duplicateOrder = await request("/api/purchase-orders", { method: "POST", body: JSON.stringify(orderRequest) });
assert.equal(duplicateOrder.body.data._id, purchaseOrder._id, "Purchase order idempotency failed.");

const approvedOrder = await request("/api/purchase-orders", {
  method: "PATCH",
  body: JSON.stringify({ id: purchaseOrder._id, action: "APPROVE" }),
});
assert.equal(approvedOrder.body.data.status, "APPROVED");

const receiveDate = businessDate;
const firstReceiptRequest = {
  id: purchaseOrder._id,
  action: "RECEIVE",
  clientRequestId: crypto.randomUUID(),
  supplierInvoiceNo: `IT-INV-${Date.now()}-A`,
  invoiceDate: receiveDate,
  receivedAt: receiveDate,
  notes: "First carton",
  lines: [{ productId: product._id, quantity: 1 }],
};
const firstReceipt = await request("/api/purchase-orders", { method: "PATCH", body: JSON.stringify(firstReceiptRequest) });
assert.equal(firstReceipt.body.data.order.status, "PARTIALLY_RECEIVED");
assert.equal(firstReceipt.body.data.bill.status, "OPEN");
assert.equal(firstReceipt.body.data.bill.total, 4.36);
const duplicateReceipt = await request("/api/purchase-orders", { method: "PATCH", body: JSON.stringify(firstReceiptRequest) });
assert.equal(duplicateReceipt.body.data.receipt._id, firstReceipt.body.data.receipt._id, "Goods receipt idempotency failed.");
const afterDuplicateReceipt = await request("/api/products?barcode=9555000000012");
assert.equal(afterDuplicateReceipt.body.data[0].stock, 3, "A duplicate goods receipt changed stock.");

const secondReceipt = await request("/api/purchase-orders", {
  method: "PATCH",
  body: JSON.stringify({
    ...firstReceiptRequest,
    clientRequestId: crypto.randomUUID(),
    supplierInvoiceNo: `IT-INV-${Date.now()}-B`,
    notes: "Final carton",
  }),
});
assert.equal(secondReceipt.body.data.order.status, "RECEIVED");
const afterReceiving = await request("/api/products?barcode=9555000000012");
assert.equal(afterReceiving.body.data[0].stock, 4);
assert.equal(afterReceiving.body.data[0].cost, 4);

const payableResponse = await request("/api/accounts-payable");
const orderBills = payableResponse.body.data.bills.filter((bill) => bill.purchaseOrderNo === purchaseOrder.purchaseOrderNo);
assert.equal(orderBills.length, 2);
const settlementAccount = payableResponse.body.data.accounts.find((account) => account.code === "1010") || payableResponse.body.data.accounts[0];
assert.ok(settlementAccount?.code);
let duplicatePaymentRequest;
let duplicatePaymentId;
for (const [index, bill] of orderBills.entries()) {
  const paymentRequest = {
    id: bill._id,
    clientRequestId: crypto.randomUUID(),
    amount: bill.balance,
    paymentAccountCode: settlementAccount.code,
    reference: `IT-BANK-${index + 1}`,
    paidAt: receiveDate,
    notes: "Integration supplier settlement",
  };
  const paid = await request("/api/accounts-payable", { method: "PATCH", body: JSON.stringify(paymentRequest) });
  assert.equal(paid.body.data.bill.status, "PAID");
  if (index === 0) {
    duplicatePaymentRequest = paymentRequest;
    duplicatePaymentId = paid.body.data.payment._id;
  }
}
const duplicatePayment = await request("/api/accounts-payable", { method: "PATCH", body: JSON.stringify(duplicatePaymentRequest) });
assert.equal(duplicatePayment.body.data.payment._id, duplicatePaymentId, "Supplier payment idempotency failed.");
const settledPayables = await request("/api/accounts-payable");
assert.ok(settledPayables.body.data.bills.filter((bill) => bill.purchaseOrderNo === purchaseOrder.purchaseOrderNo).every((bill) => bill.status === "PAID"));
const supplierLedger = await request("/api/suppliers");
const testedSupplier = supplierLedger.body.data.find((item) => item._id === supplier._id);
assert.equal(testedSupplier.pulse.punctuality, 100);
assert.equal(testedSupplier.outstandingBase, 0);

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
    "supplier and idempotent purchase order created",
    "partial and final goods receipts posted atomically",
    "duplicate receipt blocked from changing stock",
    "inventory weighted cost and AP bills reconciled",
    "supplier bills paid with idempotent settlement",
    "Supply Pulse updated from delivery performance",
  ],
  stocktakeNo: stocktakeResponse.body.data.stocktakeNo,
  receiptNo: saleResponse.body.data.receiptNo,
  purchaseOrderNo: purchaseOrder.purchaseOrderNo,
}, null, 2));
