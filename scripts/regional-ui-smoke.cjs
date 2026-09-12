// Browser-only acceptance checks. API fixtures never touch business data.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require(path.join(process.argv[2], 'playwright'));
const esbuild = require('esbuild');

async function main() {
  let browser;
  try { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  catch { browser = await chromium.launch({ headless: true }); }
  try {
    await fs.mkdir('.artifacts/regional', { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/setup', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { configured: false, registrationOpen: true } }) }));
    await page.goto('http://127.0.0.1:3000/setup');
    const country = page.locator('select[name="countryCode"]');
    await country.waitFor();
    assert.equal(await country.inputValue(), '');
    assert.equal(await country.locator('option').count(), 250);
    await country.selectOption('MY');
    assert.equal(await page.locator('select[name="currency"]').inputValue(), 'MYR');
    assert.equal(await page.locator('input[name="timeZone"]').inputValue(), 'Asia/Kuala_Lumpur');
    await country.selectOption('DE');
    assert.equal(await page.locator('select[name="currency"]').inputValue(), 'EUR');
    assert.equal(await page.locator('input[name="locale"]').inputValue(), 'de-DE');
    assert.match(await page.locator('.regional-preview').innerText(), /1\.234,50/);
    await page.locator('input[type="search"]').fill('japan');
    await country.selectOption('JP');
    assert.equal(await page.locator('select[name="currency"]').inputValue(), 'JPY');
    await page.locator('input[type="search"]').fill('');
    await page.screenshot({ path: '.artifacts/regional/setup-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.artifacts/regional/setup-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true, 'Setup horizontal overflow');

    // Exercise the actual SettingsView with explicit API fixtures, not a production session.
    const bundle = await esbuild.build({
      stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SettingsView} from './components/settings-view'; createRoot(document.getElementById('root')).render(React.createElement(SettingsView));`, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    });
    let settings = { key: 'business', businessName: 'Sample local store', legalEntityName: '', registrationNo: '', email: '', phone: '', address: '', countryCode: 'SG', currency: 'SGD', acceptedCurrencies: ['SGD'], locale: 'en-SG', timeZone: 'Asia/Singapore', taxName: 'GST', taxRate: 9, taxMode: 'EXCLUSIVE', pointsPerDollar: 1, lowStockNotifications: true, organizationType: 'INDEPENDENT', franchiseBrand: '', franchiseCode: '', parentOrganizationCode: '', updatedAt: '2026-09-12T00:00:00Z' };
    let posted;
    await page.route('**/api/settings', async route => {
      if (route.request().method() === 'PATCH') { posted = route.request().postDataJSON(); settings = { ...settings, ...posted, updatedAt: new Date().toISOString() }; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: settings }) });
    });
    await page.route('**/api/settings/history', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }));
    await page.route('**/api/system-control', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { mode: 'OPEN', reason: '', scannerGeneration: 1 } }) }));
    const css = await fs.readFile('app/globals.css', 'utf8');
    await page.route('**/regional-ui-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script></html>` }));
    await page.goto('http://127.0.0.1:3000/regional-ui-fixture');
    await page.locator('select[name="countryCode"]').selectOption('MY');
    assert.equal(await page.locator('input[name="currency"]').inputValue(), 'SGD');
    assert.equal(await page.locator('input[name="taxRate"]').inputValue(), '0');
    assert.equal(await page.locator('.regional-settings select:disabled').first().isDisabled(), true);
    await page.getByLabel("I have reviewed the new country's tax rate, pricing mode and business time zone. Historical documents will not be rewritten.").check();
    await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
    await page.waitForTimeout(1500);
    assert.equal(posted.countryCode, 'MY');
    assert.equal(posted.currency, 'SGD');
    assert.equal(posted.timeZone, 'Asia/Kuala_Lumpur');
    assert.equal(await page.locator('select[name="countryCode"]').inputValue(), 'MY');
    await page.screenshot({ path: '.artifacts/regional/settings-fixture-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true, 'Settings horizontal overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.artifacts/regional/settings-fixture-desktop.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS real setup UI: country search, MY/DE/JP defaults, previews, desktop and mobile');
    console.log('PASS SettingsView with API fixtures: save/reload, independent main country, currency protection, desktop and mobile');
    console.log('No database records were read or changed by these UI checks.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
