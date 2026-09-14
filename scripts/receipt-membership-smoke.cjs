// Isolated loopback MongoDB + production-build HTTP/browser acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { MongoClient, ObjectId } = require('mongodb');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve('.artifacts/regional-mongo');
  const externalUri = process.env.COMMERCE_TEST_MONGODB_URI;
  const tempRoot = await fs.realpath(os.tmpdir());
  const runPath = await fs.mkdtemp(path.join(tempRoot, 'konkon-commerce-'));
  const output = path.resolve('.artifacts/commerce-qa');
  await fs.mkdir(runPath, { recursive: true }); await fs.mkdir(output, { recursive: true });
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const dbName = `konkon_qa_commerce_${randomBytes(8).toString('hex')}`;
  let replica, client, server, browser, isolatedDb;
  try {
    let uri = externalUri;
    if (!uri) {
      const runtime = require(path.join(root, 'node_modules/mongodb-memory-server'));
      const { MongoBinary } = require(path.join(root, 'node_modules/mongodb-memory-server-core'));
      const binary = await MongoBinary.getPath({ version: '7.0.24' });
      // Keep the database process in its disposable local directory, outside synced workspaces.
      replica = new runtime.MongoMemoryReplSet({ binary: { systemBinary: binary, version: '7.0.24' }, replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger', spawn: { windowsHide: true, cwd: runPath }, args: ['--wiredTigerCacheSizeGB', '0.25', '--oplogSize', '16'] }, instanceOpts: [{ dbPath: runPath, launchTimeout: 60000 }] });
      await replica.start();
      uri = replica.getUri(); assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    }
    const prefix = `cq_${randomBytes(8).toString('hex')}_`;
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 }); await client.connect();
    assert.match(dbName, /^konkon_qa_commerce_[a-f0-9]{16}$/);
    const rawDb = client.db(dbName);
    assert.equal((await rawDb.listCollections({}, { nameOnly: true }).toArray()).length, 0, 'Refuse to reuse an existing database');
    isolatedDb = rawDb;
    console.log(`READY ${dbName}; production collections are not accessed.`);
    const collection = name => rawDb.collection(prefix + name);
    const env = { ...process.env, MONGODB_URI: uri, MONGODB_DB_NAME: dbName, MONGODB_COLLECTION_PREFIX: prefix, AUTH_SECRET: randomBytes(40).toString('hex'), IDENTITY_LOOKUP_SECRET: randomBytes(40).toString('hex'), CRON_SECRET: randomBytes(40).toString('hex'), NEXT_PUBLIC_APP_URL: base, NODE_ENV: 'production' };
    let ready = false; let exited = false;
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { if (String(data).includes('Ready')) ready = true; });
    server.stderr.on('data', () => {}); server.on('exit', () => { exited = true; });
    for (let i = 0; i < 80 && !ready && !exited; i++) await sleep(500);
    assert.ok(ready, 'Local app ready');
    let cookie = '';
    async function api(url, method = 'GET', body, status = 200, authenticated = true) {
      const response = await fetch(base + url, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'manual' });
      const json = await response.json();
      if (Array.isArray(status)) assert.ok(status.includes(response.status), `${url}: ${response.status} ${json.error || 'unexpected response'}`);
      else assert.equal(response.status, status, `${url}: ${json.error || 'unexpected response'}`);
      const nextCookie = response.headers.get('set-cookie')?.split(';')[0]; if (nextCookie) cookie = nextCookie;
      return json.data;
    }
    const password = `TestOwner9${randomBytes(16).toString('hex')}`;
    console.log('Starting isolated Owner setup.');
    await api('/api/setup', 'POST', { businessName: 'Commerce Test Matcha', fullName: 'Test Owner', username: 'testowner', email: 'owner@test.example', password, countryCode: 'MY', currency: 'MYR', acceptedCurrencies: ['MYR'], locale: 'en-MY', timeZone: 'Asia/Kuala_Lumpur', taxName: 'Test tax', taxRate: 0, taxMode: 'EXCLUSIVE', seedProducts: false }, 201);
    const product = await api('/api/products', 'POST', { sku: 'QA-TEA', barcode: '9551234567890', name: 'Test Matcha Tea', category: 'Tea', unit: 'pack', price: 10, cost: 3, stock: 20, reorderLevel: 2 }, 201);
    const member = await api('/api/members', 'POST', { name: 'Test Member', phone: '+60123456789', email: 'member@test.example', identityNumber: 'TEST12345', identityType: 'NATIONAL_ID' }, 201);
    assert.ok(!JSON.stringify(member).includes('identityLookupHash'));
    if (process.argv.includes('--ui-only')) {
      const { chromium } = require(path.join(process.argv[2], 'playwright'));
      browser = await chromium.launch({ headless: true, channel: 'msedge' });
      const context = await browser.newContext();
      const [name, ...value] = cookie.split('=');
      await context.addCookies([{ name, value: value.join('='), url: base, httpOnly: true, sameSite: 'Lax' }]);
      await require('./ui-interactions-smoke.cjs')({ page: await context.newPage(), base, output });
      return;
    }
    const cardBody = { memberId: member._id, clientRequestId: randomUUID(), label: 'Primary NFC card', tier: 'MATCHA GOLD', accentColor: '#173f2a' };
    const issued = await Promise.all([api('/api/member-cards', 'POST', cardBody, [200, 201]), api('/api/member-cards', 'POST', cardBody, [200, 201])]);
    const card = issued[0]; assert.equal(issued[1]._id, card._id);
    await api('/api/member-cards/lookup', 'POST', { code: 'invalid' }, 401, false);
    assert.equal((await api('/api/member-cards', 'POST', cardBody))._id, card._id);
    const { token } = await api('/api/member-cards', 'POST', { action: 'REVEAL', id: card._id });
    const stored = await collection('memberCards').findOne({ _id: new ObjectId(card._id) });
    assert.ok(stored.encryptedToken && stored.tokenHash); assert.ok(!JSON.stringify(stored).includes(token));
    const list = await api(`/api/member-cards?memberId=${member._id}`); assert.ok(!JSON.stringify(list).includes('encryptedToken')); assert.ok(!JSON.stringify(list).includes('tokenHash'));
    assert.equal((await api('/api/member-cards/lookup', 'POST', { code: token.toLowerCase() }))._id, member._id);
    await api('/api/member-cards', 'PATCH', { id: card._id, status: 'SUSPENDED' }); await api('/api/member-cards/lookup', 'POST', { code: token }, 410);
    await api('/api/member-cards', 'PATCH', { id: card._id, status: 'ACTIVE', label: 'Updated card' });
    await api('/api/member-cards/lookup', 'POST', { code: token });
    await api('/api/member-cards', 'PATCH', { id: card._id, status: 'VOID' }); await api('/api/member-cards/lookup', 'POST', { code: token }, 410);
    await api('/api/member-cards', 'PATCH', { id: card._id, status: 'ACTIVE' }, 409);
    await api('/api/member-cards', 'DELETE', { id: card._id }); await api('/api/member-cards/lookup', 'POST', { code: token }, 410);
    console.log('PASS encrypted card issuance, retry, metadata-only listing, suspend/reactivate/void/delete and lookup guards.');
    const boundCode = `KKNT1-S-${'ab'.repeat(32)}`;
    const boundCard = await api('/api/member-cards', 'POST', { action: 'BIND', memberId: member._id, code: boundCode, clientRequestId: randomUUID(), label: 'Hotel card', tier: 'MATCHA CLUB', accentColor: '#173f2a' }, 201);
    assert.equal((await api('/api/member-cards/lookup', 'POST', { code: boundCode }))._id, member._id);
    assert.ok(!JSON.stringify(await api(`/api/member-cards?memberId=${member._id}`)).includes('bindingHash'));
    await api('/api/member-cards', 'PATCH', { id: boundCard._id, status: 'SUSPENDED' }); await api('/api/member-cards/lookup', 'POST', { code: boundCode }, 410);
    await api('/api/member-cards', 'PATCH', { id: boundCard._id, status: 'ACTIVE' }); await api('/api/member-cards', 'DELETE', { id: boundCard._id }); await api('/api/member-cards/lookup', 'POST', { code: boundCode }, 410);
    console.log('PASS existing NFC card binding, metadata privacy and suspend/delete lookup guards.');
    const orphanMember = await api('/api/members', 'POST', { name: 'Archived NFC Member', phone: '+60198765432', email: 'archived-nfc@test.example' }, 201);
    const orphanCode = `KKNT1-N-${randomBytes(32).toString('hex')}`;
    const orphanCard = await api('/api/member-cards', 'POST', { action: 'BIND', memberId: orphanMember._id, code: orphanCode, clientRequestId: randomUUID(), label: 'Archived hotel card', tier: 'MATCHA CLUB', accentColor: '#173f2a' }, 201);
    await api('/api/members', 'DELETE', { id: orphanMember._id });
    const orphanRows = await api('/api/member-cards?orphaned=1');
    assert.equal(orphanRows.length, 1); assert.equal(orphanRows[0]._id, orphanCard._id); assert.equal(orphanRows[0].member.memberNo, orphanMember.memberNo); assert.ok(!JSON.stringify(orphanRows).includes('bindingHash'));
    const orphanLookup = await api('/api/member-cards/lookup', 'POST', { code: orphanCode, includeOrphan: true });
    assert.equal(orphanLookup.orphan, true); assert.equal(orphanLookup.card.id, orphanCard._id); assert.equal(orphanLookup.member.memberNo, orphanMember.memberNo);
    await api('/api/member-cards/lookup', 'POST', { code: orphanCode }, 410);
    await api('/api/member-cards', 'PATCH', { id: orphanCard._id, status: 'SUSPENDED' });
    assert.equal((await api('/api/member-cards/lookup', 'POST', { code: orphanCode, includeOrphan: true })).orphan, true);
    await api('/api/member-cards', 'PATCH', { id: orphanCard._id, status: 'ACTIVE' });
    const orphanMemberById = await api('/api/members', 'POST', { name: 'Archived NFC Member Two', phone: '+60198765433', email: 'archived-nfc-two@test.example' }, 201);
    const orphanCardById = await api('/api/member-cards', 'POST', { action: 'BIND', memberId: orphanMemberById._id, code: `KKNT1-S-${randomBytes(32).toString('hex')}`, clientRequestId: randomUUID(), label: 'Archived second card', tier: 'MATCHA CLUB', accentColor: '#173f2a' }, 201);
    await api('/api/members', 'DELETE', { id: orphanMemberById._id });
    await api('/api/member-cards', 'PATCH', { id: orphanCardById._id, status: 'VOID' });
    assert.equal((await api('/api/member-cards?orphaned=1')).length, 2);
    await api('/api/member-cards', 'POST', { action: 'CLEAR_ORPHAN', id: orphanCardById._id });
    assert.equal((await api('/api/member-cards?orphaned=1')).length, 1);
    console.log('PASS orphan NFC listing and restricted archived-member lookup.');
    const activeCard = await api('/api/member-cards', 'POST', { ...cardBody, clientRequestId: randomUUID(), label: 'Phone NFC test' }, 201);
    const activeToken = (await api('/api/member-cards', 'POST', { action: 'REVEAL', id: activeCard._id })).token;
    const nextMember = await api('/api/members', 'POST', { name: 'Next Tap Member', phone: '+60112233445' }, 201);
    const nextCard = await api('/api/member-cards', 'POST', { ...cardBody, memberId: nextMember._id, clientRequestId: randomUUID(), label: 'Next tap card' }, 201);
    const nextToken = (await api('/api/member-cards', 'POST', { action: 'REVEAL', id: nextCard._id })).token;
    const existingSerial = 'AB-CD-01';
    const existingCode = `KKNT1-S-${createHash('sha256').update('serial:' + existingSerial).digest('hex')}`;
    await api('/api/member-cards', 'POST', { action: 'BIND', memberId: member._id, code: existingCode, clientRequestId: randomUUID(), label: 'Live reader existing card', tier: 'MATCHA CLUB', accentColor: '#173f2a' }, 201);
    const sale = await api('/api/sales', 'POST', { clientRequestId: randomUUID(), paymentMethod: 'CASH', tenderedAmount: 100, memberId: member._id, items: [{ productId: product._id, quantity: 2 }], saleNote: 'PRIVATE ORDER NOTE', paymentReference: 'PRIVATE PAY REF' }, 201);
    const documentsQa = require('./country-documents-smoke.cjs');
    const docFixtures = await documentsQa.apiChecks({ api, collection, base, cookie: () => cookie, member, sale });
    if (process.argv.includes('--maintenance-only')) {
      await require('./deletion-maintenance-smoke.cjs')({ api, collection, base, cookie: () => cookie, env, product });
      return;
    }
    assert.ok(sale.publicReceiptUrl); assert.equal(new URL(sale.publicReceiptUrl).origin, base); const receiptToken = new URLSearchParams(new URL(sale.publicReceiptUrl).hash.slice(1)).get('receipt');
    await api(`/api/sales?id=${sale._id}`, 'GET', undefined, 401, false);
    const publicSale = await api('/api/public-receipts', 'POST', { token: receiptToken }, 200, false);
    assert.equal(publicSale.total, 20); assert.equal(publicSale.eInvoice.status, 'NOT_SUBMITTED');
    assert.doesNotMatch(JSON.stringify(publicSale), /PRIVATE ORDER|PRIVATE PAY|identityLookupHash|lineCost|totalCost|memberName|cashierName/);
    await api('/api/public-receipts', 'POST', { token: receiptToken.slice(0, -1) + (receiptToken.endsWith('0') ? '1' : '0') }, 404, false);
    assert.equal((await api('/api/receipt-lookup', 'POST', { code: sale.publicReceiptUrl })).id, sale._id);
    assert.equal((await api('/api/receipt-lookup', 'POST', { code: sale.receiptNo })).id, sale._id);
    await api('/api/refunds', 'POST', { saleId: sale._id, reason: 'Customer return', items: [{ productId: product._id, quantity: 1 }] }, 201);
    const afterRefund = await api('/api/public-receipts', 'POST', { token: receiptToken }, 200, false);
    assert.equal(afterRefund.refundedAmount, 10); assert.equal(afterRefund.status, 'PARTIALLY_REFUNDED');
    await api('/api/e-invoices', 'POST', { ...docFixtures.body, sourceType: 'RECEIPT', sourceId: sale._id, clientRequestId: randomUUID() }, 409);
    await api('/api/refunds', 'POST', { saleId: sale._id, reason: 'Too many returns', items: [{ productId: product._id, quantity: 2 }] }, 422);
    assert.equal(await collection('journalEntries').countDocuments({ source: 'POS_REFUND' }), 1);
    await collection('users').updateOne({ username: 'testowner' }, { $set: { role: 'ACCOUNTANT' } });
    try {
      await api('/api/member-cards', 'POST', { action: 'REVEAL', id: activeCard._id }, 403);
      await api('/api/refunds', 'POST', { saleId: sale._id, reason: 'Unauthorized return', items: [{ productId: product._id, quantity: 1 }] }, 403);
      await api('/api/scanner-sessions', 'POST', { label: 'Unauthorized stock scanner', purpose: 'INVENTORY' }, 403);
      await api('/api/receipt-lookup', 'POST', { code: sale.publicReceiptUrl });
      await api('/api/member-cards/lookup', 'POST', { code: activeToken });
    } finally { await collection('users').updateOne({ username: 'testowner' }, { $set: { role: 'OWNER' } }); }
    console.log('PASS sale QR, customer privacy, receipt-number/QR lookup, partial refund and over-refund rejection.');
    console.log('PASS authoritative role checks: read-only operator cannot reveal credentials, refund or issue an inventory scanner.');
    const pass = await api('/api/scanner-sessions', 'POST', { label: 'Commerce phone', purpose: 'RECEIPTS' }, 201);
    const phoneToken = new URL(pass.url).pathname.split('/').at(-1);
    await api('/api/mobile-scans', 'POST', { token: phoneToken, action: 'CONNECT' }, 200, false);
    await api('/api/mobile-scans', 'POST', { token: phoneToken, code: sale.publicReceiptUrl }, 201, false);
    const storedEvent = await collection('scannerEvents').findOne({ scannerSessionId: new ObjectId(pass.session._id) });
    assert.ok(storedEvent.encryptedCode); assert.equal(storedEvent.code, undefined);
    const consumer = randomUUID();
    const events = await api(`/api/mobile-scans?sessionId=${pass.session._id}&consumerId=${consumer}&purpose=RECEIPTS`);
    assert.equal(events[0].code, sale.publicReceiptUrl.toUpperCase());
    await api('/api/mobile-scans', 'PATCH', { sessionId: pass.session._id, consumerId: consumer, eventIds: events.map(event => event._id) });
    const consumed = await collection('scannerEvents').findOne({ _id: storedEvent._id });
    assert.ok(!consumed || !consumed.encryptedCode && !consumed.code && consumed.expiresAt <= new Date(Date.now() + 61000));
    await api('/api/scanner-sessions', 'PATCH', { id: pass.session._id, purpose: 'MEMBERS' });
    console.log('PASS phone receipt routing, encrypted event storage, claim and acknowledgement.');
    const { chromium } = require(path.join(process.argv[2], 'playwright'));
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const staff = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const mockNfc = () => {
      window.__readers = [];
      window.NDEFReader = class {
        async scan({ signal }) { this.signal = signal; window.__testReader = this; window.__readers.push(this); }
        async write(message) { window.__writtenNdef = message; }
      };
    };
    const tap = (target, code) => target.evaluate(async value => {
      const bytes = new TextEncoder().encode(value);
      await window.__testReader.onreading({ message: { records: [{ recordType: 'text', encoding: 'utf-8', data: new DataView(bytes.buffer) }] } });
    }, code);
    await staff.addInitScript(mockNfc);
    const [name, ...value] = cookie.split('='); await staff.addCookies([{ name, value: value.join('='), url: base, httpOnly: true, sameSite: 'Lax' }]);
    const page = await staff.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/pos'); await page.locator('.pos-nfc-reader [data-nfc-always-on="true"]').waitFor(); await page.getByRole('button', { name: /Test Matcha Tea/ }).click();
    await page.waitForFunction(() => Boolean(window.__testReader));
    const directLookup = page.waitForResponse(response => response.url().endsWith('/api/member-cards/lookup') && response.status() === 200);
    await tap(page, activeToken);
    assert.equal((await (await directLookup).json()).data._id, member._id);
    assert.equal(await page.evaluate(() => window.__testReader.signal.aborted), false);
    assert.equal(await page.getByRole('status', { name: 'NFC reader listening', exact: true }).isVisible(), true);
    const directNext = page.waitForResponse(response => response.url().endsWith('/api/member-cards/lookup') && response.status() === 200);
    await tap(page, nextToken);
    assert.equal((await (await directNext).json()).data._id, nextMember._id);
    await page.waitForFunction(id => document.querySelector('.member-select select')?.value === id, nextMember._id);
    const directExisting = page.waitForResponse(response => response.url().endsWith('/api/member-cards/lookup') && response.status() === 200);
    await page.evaluate(async serialNumber => window.__testReader.onreading({ serialNumber, message: { records: [] } }), existingSerial);
    assert.equal((await (await directExisting).json()).data._id, member._id);
    await page.waitForFunction(id => document.querySelector('.member-select select')?.value === id, member._id);
    console.log('PASS resident POS NFC automatically starts, reads consecutive members and existing cards without stopping.');
    const quantity = page.getByRole('textbox', { name: 'Test Matcha Tea quantity', exact: true });
    await quantity.fill('5'); await quantity.press('Tab'); assert.equal(await quantity.inputValue(), '5');
    await quantity.fill('999'); await quantity.press('Tab'); assert.equal(await quantity.inputValue(), '5');
    await page.getByRole('textbox', { name: 'Point of sale barcode input' }).fill(orphanCode);
    await page.getByRole('button', { name: 'Read code', exact: true }).click();
    await page.getByRole('button', { name: 'Clear NFC registration' }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('SAFE TO CLEAR'));
    assert.equal((await api('/api/member-cards?orphaned=1')).length, 0);
    await api('/api/member-cards/lookup', 'POST', { code: orphanCode }, 410);
    console.log('PASS POS scanner orphan detection and code-based NFC cleanup.');
    await page.screenshot({ path: path.join(output, 'pos-quantity.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
    await page.screenshot({ path: path.join(output, 'pos-nfc-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.goto(base + '/receipts');
    await page.getByRole('textbox', { name: 'Receipts barcode input' }).fill(sale.publicReceiptUrl);
    await page.getByRole('button', { name: 'Read code', exact: true }).click();
    await page.waitForURL(`**/receipts/${sale._id}`); await page.locator('[data-receipt-qr] img').waitFor();
    assert.ok(await page.getByRole('button', { name: 'Refund items' }).isVisible());
    await page.screenshot({ path: path.join(output, 'staff-receipt.png'), fullPage: true });
    await page.goto(base + `/members/${member._id}/card`); await page.getByRole('button', { name: 'QR / NFC / print' }).click(); await page.locator('.member-exclusive-card img').waitFor();
    await page.screenshot({ path: path.join(output, 'member-card.png'), fullPage: true });
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.printable-member-card').isVisible(), false);
    assert.equal(await page.locator('.member-exclusive-card img').isVisible(), true);
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
    await page.screenshot({ path: path.join(output, 'member-card-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.goto(base + '/members'); await page.locator('.workflow-nfc-reader [data-nfc-always-on="true"]').waitFor();
    await page.waitForFunction(() => Boolean(window.__testReader));
    await tap(page, nextToken);
    await page.waitForFunction(() => document.querySelector('.member-grid')?.textContent.includes('Next Tap Member'));
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // Simulated browser device boundary; actual NFC hardware is not claimed tested.
    await phone.addInitScript(mockNfc);
    const mobile = await phone.newPage(); await mobile.goto(base + '/scan/' + phoneToken);
    await mobile.waitForFunction(() => Boolean(window.__testReader));
    const memberLookup = page.waitForResponse(response => response.url().endsWith('/api/member-cards/lookup') && response.status() === 200);
    await mobile.evaluate(code => { const bytes = new TextEncoder().encode(code); window.__testReader.onreading({ message: { records: [{ recordType: 'text', encoding: 'utf-8', data: new DataView(bytes.buffer) }] } }); }, activeToken);
    assert.equal((await (await memberLookup).json()).data._id, member._id);
    await page.waitForFunction(() => document.querySelector('.member-grid')?.textContent.includes('Test Member'));
    // Hold one card in place: only one outbound event; the reader stays live.
    let posts = 0;
    const countPosts = request => { if (request.url().endsWith('/api/mobile-scans') && request.method() === 'POST' && request.postDataJSON()?.code) posts++; };
    mobile.on('request', countPosts);
    await mobile.waitForFunction(() => document.querySelector('.nfc-control p')?.textContent.includes('Ready for the next card'));
    await sleep(350);
    const secondLookup = page.waitForResponse(response => response.url().endsWith('/api/member-cards/lookup') && response.status() === 200);
    await Promise.all([tap(mobile, nextToken), tap(mobile, nextToken), tap(mobile, nextToken)]);
    assert.equal((await (await secondLookup).json()).data._id, nextMember._id);
    assert.equal(posts, 1);
    mobile.off('request', countPosts);
    // A hidden phone page is suspended by the browser, not disconnected by us.
    await mobile.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await mobile.evaluate(() => window.__testReader.signal.aborted), false);
    await mobile.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await mobile.evaluate(() => window.__readers.length), 1);
    // Switch the counter only: the same open phone reader follows POS.
    await page.goto(base + '/pos');
    await page.waitForFunction(() => document.querySelector('.scanner-bridge-live'));
    const posPhoneLookup = page.waitForResponse(response => response.url().endsWith('/api/member-cards/lookup') && response.status() === 200);
    await tap(mobile, activeToken);
    assert.equal((await (await posPhoneLookup).json()).data._id, member._id);
    assert.equal(await mobile.evaluate(() => window.__testReader.signal.aborted), false);
    assert.equal(await mobile.evaluate(() => window.__readers.length), 1);
    await page.waitForFunction(id => document.querySelector('.member-select select')?.value === id, member._id);
    // A transient delivery failure must allow the same card to be retried.
    await mobile.route('**/api/mobile-scans', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Temporary test delivery failure' }) }), { times: 1 });
    await tap(mobile, nextToken);
    await mobile.waitForFunction(() => document.querySelector('.nfc-control p')?.textContent.includes('Tap it again to retry'));
    const retryLookup = page.waitForResponse(response => response.url().endsWith('/api/member-cards/lookup') && response.status() === 200);
    await tap(mobile, nextToken);
    assert.equal((await (await retryLookup).json()).data._id, nextMember._id);
    await page.waitForFunction(id => document.querySelector('.member-select select')?.value === id, nextMember._id);
    console.log('PASS same phone NFC reader stays live across cards, duplicate bursts, background/foreground and Members-to-POS routing.');
    console.log('PASS NFC same-card retry immediately after transient delivery failure.');
    await mobile.screenshot({ path: path.join(output, 'phone-nfc.png'), fullPage: true });
    await mobile.goto(base + `/card-write#card=${activeToken}`); await mobile.getByRole('heading', { name: 'Prepare an NFC card', exact: true }).waitFor(); await mobile.locator('.nfc-control button').waitFor(); await mobile.locator('.nfc-control button').click();
    const written = await mobile.evaluate(() => window.__writtenNdef.records[0].data); assert.equal(written, activeToken);
    await mobile.goto(sale.publicReceiptUrl); await mobile.getByRole('button', { name: 'Export CSV' }).waitFor();
    const [download] = await Promise.all([mobile.waitForEvent('download'), mobile.getByRole('button', { name: 'Export CSV' }).click()]); assert.equal(download.suggestedFilename(), sale.receiptNo + '.csv');
    assert.ok(!mobile.url().includes('#')); assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
    await mobile.locator('[data-receipt-qr] img').waitFor();
    const exportData = await (await api('/api/public-receipts', 'POST', { token: receiptToken }, 200, false));
    assert.equal(exportData.items[0].refundedQuantity, 1);
    assert.equal(exportData.tenderedAmount, 100);
    await mobile.screenshot({ path: path.join(output, 'customer-receipt-mobile.png'), fullPage: true });
    await documentsQa.browserChecks({ page, mobile, api, member, base, output, fixtures: docFixtures, phoneToken, passId: pass.session._id, activeToken, nextToken });
    await api('/api/users', 'POST', { fullName: 'Responsive Staff Long Name', username: 'responsive_staff', email: 'responsive.staff.long.address@test.example', role: 'CASHIER', password: 'IsolatedResponsive123!' }, 201);
    await require('./ui-interactions-smoke.cjs')({ page, base, output });
    assert.deepEqual(errors, []);
    await api('/api/scanner-sessions', 'DELETE', { id: pass.session._id }); await api('/api/mobile-scans', 'POST', { token: phoneToken, code: activeToken }, 410, false);
    await require('./deletion-maintenance-smoke.cjs')({ api, collection, base, cookie: () => cookie, env, product });
    console.log('PASS real browser quantity editing, scanner receipt navigation, card management, mobile receipt export; simulated NFC read/write boundary.');
  } catch (error) {
    console.error('ACCEPTANCE FAILURE:', String(error.stack || error).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[redacted connection]').slice(0, 4000));
    throw error;
  } finally {
    await browser?.close();
    if (server) { server.kill(); await sleep(1000); }
    if (isolatedDb) { assert.equal(isolatedDb.databaseName, dbName); assert.match(dbName, /^konkon_qa_commerce_[a-f0-9]{16}$/); const owned = await isolatedDb.listCollections({}, { nameOnly: true }).toArray(); for (const entry of owned) { assert.ok(entry.name.startsWith('cq_')); await isolatedDb.collection(entry.name).drop(); } }
    await client?.close(); await replica?.stop({ doCleanup: false });
    const actual = await fs.realpath(runPath);
    assert.equal(path.dirname(actual), tempRoot); assert.match(path.basename(actual), /^konkon-commerce-[a-zA-Z0-9]+$/);
    await fs.rm(actual, { recursive: true, maxRetries: 10, retryDelay: 500 });
    console.log('CLEANUP isolated temporary database removed; production untouched.');
  }
}
main().catch(error => { const safe = String(error.message).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[redacted connection]').slice(0, 500); console.error(`${error.name} ${error.code || ''}: ${safe}`); process.exitCode = 1; });
