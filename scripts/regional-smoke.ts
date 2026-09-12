// Real HTTP + MongoDB + browser checks, isolated from business collections.
// Run after a production build. All test collections use a fresh guarded prefix.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { dateKeyInTimeZone } from "../lib/dates";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!process.env.MONGODB_URI || process.env.MONGODB_URI.includes("[SENSITIVE]")) throw new Error("A real local test database URI is required; Vercel secret placeholders cannot be used.");
  const prefix = `rgtest_${randomBytes(8).toString("hex")}_`;
  assert.match(prefix, /^rgtest_[a-f0-9]{16}_$/);
  const base = "http://127.0.0.1:3101";
  const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "konkon_matcha_accounting");
  assert.equal((await db.listCollections({ name: { $regex: `^${prefix}` } }).toArray()).length, 0);
  let cookie = "";
  // The optional browser runner lives in the desktop dependency bundle, not production dependencies.
  let browser: any;
  let ready = false;
  let serverExited = false;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", MONGODB_COLLECTION_PREFIX: prefix, AUTH_SECRET: randomBytes(40).toString("hex"), IDENTITY_LOOKUP_SECRET: randomBytes(40).toString("hex"), PAYMENT_WEBHOOK_SECRET: randomBytes(40).toString("hex") },
  });
  // Do not echo server output: diagnostics can contain deployment details.
  server.stdout.on("data", chunk => { if (String(chunk).includes("Ready")) ready = true; });
  server.stderr.on("data", () => {});
  server.on("exit", () => { serverExited = true; });
  async function request(endpoint: string, method = "GET", body?: unknown, expected = 200) {
    const response = await fetch(`${base}${endpoint}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { cookie, origin: base, host: "127.0.0.1:3101", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map(value => value.split(";")[0]).join("; ");
    const payload = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint}: ${payload.error || "unexpected status"}`);
    assert.equal(payload.ok, expected < 400);
    console.log(`PASS ${method} ${endpoint} (${expected})`);
    return payload.data;
  }
  try {
    for (let attempt = 0; attempt < 90 && !ready; attempt++) {
      if (serverExited) throw new Error("The isolated preview server could not start.");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(ready, true, "Isolated server readiness");
    assert.equal((await request("/api/setup")).configured, false);
    await request("/api/settings", "GET", undefined, 401);

    await request("/api/setup", "POST", {
      businessName: "Regional Test Store", fullName: "Test Owner", username: "regional.test", email: "regional@example.com",
      password: `Test9-${randomBytes(16).toString("hex")}`, seedProducts: false,
      countryCode: "KW", currency: "KWD", acceptedCurrencies: ["KWD"], locale: "en-KW", timeZone: "Asia/Kuwait", taxName: "Tax", taxRate: 0, taxMode: "EXCLUSIVE",
    }, 201);
    const initial = await request("/api/settings");
    assert.equal(initial.countryCode, "KW");
    assert.equal(initial.currency, "KWD");
    assert.equal((await request("/api/locations"))[0].countryCode, "KW");

    const product = await request("/api/products", "POST", { sku: "REGIONAL-TEST", name: "Sample Matcha", category: "Testing", unit: "tin", price: 1.234, cost: 0.567, stock: 10, reorderLevel: 2, barcode: "" }, 201);
    assert.equal(product.price, 1.234);
    const coupon = await request("/api/coupons", "POST", { code: "REGIONAL10", name: "Test discount", type: "PERCENT", value: 10, startsAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), usageLimit: 10 }, 201);
    assert.equal(coupon.value, 10);
    const paused = await request("/api/coupons", "PATCH", { id: coupon._id, active: false });
    assert.equal(paused.code, "REGIONAL10");
    assert.equal(paused.usageLimit, 10);
    await request("/api/coupons?code=REGIONAL10&subtotal=3.702", "GET", undefined, 422);
    const restarted = await request("/api/coupons", "PATCH", { id: coupon._id, startsAt: new Date(Date.now() - 30_000).toISOString() });
    assert.equal(restarted.active, false);
    assert.equal(restarted.usageLimit, 10);
    await request("/api/coupons", "PATCH", { id: coupon._id, active: true });
    const quote = await request("/api/coupons?code=REGIONAL10&subtotal=3.702");
    assert.equal(quote.discount, 0.37);
    const saleInput = { clientRequestId: crypto.randomUUID(), paymentMethod: "CASH", tenderCurrency: "KWD", tenderedAmount: 10, couponCode: "REGIONAL10", items: [{ productId: product._id, quantity: 3 }] };
    const sale = await request("/api/sales", "POST", saleInput, 201);
    assert.equal(sale.subtotal, 3.702);
    assert.equal(sale.total, 3.332);
    assert.equal(sale.businessSnapshot.countryCode, "KW");
    assert.equal((await request("/api/sales", "POST", saleInput))._id, sale._id);

    const invoice = await request("/api/invoices", "POST", {
      customerName: "Regional test customer", dueDate: "2026-10-01", notes: "Temporary acceptance document",
      items: [{ description: "Sample Matcha", quantity: 3, unitPrice: 1.234 }],
    }, 201);
    assert.equal(invoice.total, 3.702);
    assert.equal(invoice.items[0].lineTotal, 3.702);
    assert.equal(invoice.businessSnapshot.countryCode, "KW");
    assert.equal(invoice.dueDate, "2026-10-01T00:00:00.000Z");

    await request("/api/settings", "PATCH", { ...initial, countryCode: "MY", currency: "MYR", acceptedCurrencies: ["MYR"] }, 409);
    assert.equal((await request("/api/settings")).currency, "KWD");
    await request("/api/settings", "PATCH", { ...initial, countryCode: "MY", timeZone: "Asia/Kuala_Lumpur", locale: "en-MY", taxName: "Tax", acceptedCurrencies: ["KWD", "MYR"] });
    const savedSale = await db.collection(`${prefix}sales`).findOne({ receiptNo: sale.receiptNo });
    assert.equal(savedSale?.businessSnapshot.countryCode, "KW");
    assert.equal(savedSale?.businessSnapshot.currency, "KWD");
    const savedInvoice = await request(`/api/invoices?id=${invoice._id}`);
    assert.deepEqual(savedInvoice.businessSnapshot, invoice.businessSnapshot);
    assert.deepEqual(savedInvoice.templateSnapshot, invoice.templateSnapshot);
    await request("/api/invoices", "PATCH", { id: invoice._id, status: "PAID" });

    const firstRefund = await request("/api/refunds", "POST", { saleId: sale._id, reason: "Isolated regression test", items: [{ productId: product._id, quantity: 1 }] }, 201);
    const lastRefund = await request("/api/refunds", "POST", { saleId: sale._id, reason: "Isolated final refund", items: [{ productId: product._id, quantity: 2 }] }, 201);
    assert.equal(Math.round((firstRefund.total + lastRefund.total) * 1000), 3332);
    assert.equal((await request("/api/products"))[0].stock, 10);

    const manualDate = dateKeyInTimeZone(new Date(), "America/Los_Angeles");
    const journalInput = { date: manualDate, memo: "Regional precision check", reference: "TEST", lines: [
      { accountCode: "1000", accountName: "Cash", debit: 1.234, credit: 0 },
      { accountCode: "3000", accountName: "Equity", debit: 0, credit: 1.234 },
    ] };
    const journal = await request("/api/journals", "POST", journalInput, 201);
    assert.equal(journal.businessDate, manualDate);
    assert.equal(journal.totalDebit, 1.234);
    await request("/api/journals", "POST", { ...journalInput, lines: [journalInput.lines[0], { ...journalInput.lines[1], credit: 1.233 }] }, 422);
    const us = await request("/api/settings", "PATCH", { ...(await request("/api/settings")), countryCode: "US", locale: "en-US", timeZone: "America/Los_Angeles" });
    const dashboard = await request("/api/dashboard");
    assert.equal(dashboard.period.timeZone, us.timeZone);
    assert.equal(dashboard.period.today, dateKeyInTimeZone(new Date(), us.timeZone));
    const report = await request(`/api/reports?from=${manualDate}&to=${manualDate}`);
    assert.equal(report.period.currency, "KWD");
    assert.equal(report.integrity.balanced, true);
    assert.ok(report.integrity.journalCount >= 1);

    // These are real local pages and API responses against the isolated test ledger.
    const bundle = process.argv[2];
    if (!bundle) throw new Error("Pass the bundled Node package directory for browser QA.");
    const { chromium } = createRequire(path.resolve("package.json"))(path.join(bundle, "playwright"));
    browser = await chromium.launch({ headless: true, channel: "msedge" });
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { cookie } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.goto(`${base}/settings`);
    const country = page.locator('select[name="countryCode"]');
    await country.selectOption("DE");
    assert.equal(await page.locator('input[name="timeZone"]').inputValue(), "Europe/Berlin");
    assert.equal(await page.locator('input[name="locale"]').inputValue(), "de-DE");
    assert.equal(await page.locator('.regional-settings select:disabled').first().isDisabled(), true);
    await page.getByLabel("I have reviewed the new country's tax rate, pricing mode and business time zone. Historical documents will not be rewritten.").check();
    const saved = page.waitForResponse((response: { url(): string; request(): { method(): string } }) => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save workspace", exact: true }).click();
    assert.equal((await saved).status(), 200);
    await page.waitForTimeout(1500);
    await country.waitFor();
    assert.equal(await country.inputValue(), "DE");
    await mkdir(".artifacts/regional", { recursive: true });
    await page.screenshot({ path: ".artifacts/regional/settings-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: ".artifacts/regional/settings-mobile.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true, "Mobile page must not overflow horizontally");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/invoices/${invoice._id}`);
    await page.getByText(invoice.invoiceNo, { exact: false }).first().waitFor();
    assert.match(await page.locator('body').innerText(), /3\.702/);
    await page.screenshot({ path: ".artifacts/regional/invoice-desktop.png", fullPage: true });
    await page.goto(`${base}/receipts/${sale._id}`);
    await page.getByText(sale.receiptNo, { exact: false }).first().waitFor();
    assert.match(await page.locator('body').innerText(), /3\.332/);
    await page.screenshot({ path: ".artifacts/regional/receipt-desktop.png", fullPage: true });
    assert.deepEqual(pageErrors, []);
    console.log("PASS browser country change, saved reload, currency protection, desktop and mobile layout");
    console.log("PASS isolated regional end-to-end regression");
  } finally {
    await browser?.close();
    server.kill();
    await new Promise(resolve => setTimeout(resolve, 700));
    // Only this run's freshly generated namespace is eligible for removal.
    const names = (await db.listCollections({ name: { $regex: `^${prefix}` } }).toArray()).map(collection => collection.name);
    assert.ok(names.length <= 60 && names.every(name => name.startsWith(prefix) && /^[A-Za-z][A-Za-z0-9]*$/.test(name.slice(prefix.length))), "Unsafe test cleanup target");
    for (const name of names) await db.collection(name).drop();
    await client.close();
    console.log(`CLEANUP removed ${names.length} temporary test collections; business collections were not modified.`);
  }
}

main().catch(error => {
  console.error(String(error instanceof Error ? error.message : "Regional regression failed").replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted database URI]"));
  process.exitCode = 1;
});
