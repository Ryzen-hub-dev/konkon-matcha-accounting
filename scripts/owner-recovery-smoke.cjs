// Development-only, real MongoDB transactions + HTTP + browser recovery regression.
// Run after `npm run build`: node scripts/owner-recovery-smoke.cjs <Playwright package directory>
// Optional MongoDB test runtime: .artifacts/regional-mongo/node_modules/mongodb-memory-server
// This runner never reads .env files or connects to an externally supplied database.
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const strongPassword = () => `Recovery9-${randomBytes(16).toString('hex')}`;
const pass = label => console.log(`PASS ${label}`);

async function freePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const playwrightDirectory = process.argv[2];
  if (!playwrightDirectory) throw new Error('Pass the directory containing the optional Playwright package.');
  const repository = path.resolve(__dirname, '..');
  const runtimeRoot = path.join(repository, '.artifacts', 'regional-mongo');
  const runName = `owner-run-${randomBytes(8).toString('hex')}`;
  const runPath = path.join(runtimeRoot, runName);
  const prefix = `ortest_${randomBytes(8).toString('hex')}_`;
  assert.match(prefix, /^ortest_[a-f0-9]{16}_$/);
  process.env.MONGOMS_DOWNLOAD_DIR = path.join(runtimeRoot, 'binaries');
  const { MongoMemoryReplSet } = require(path.join(runtimeRoot, 'node_modules', 'mongodb-memory-server'));
  const { chromium } = require(path.join(path.resolve(playwrightDirectory), 'playwright'));
  const { ObjectId } = require('mongodb');
  await fs.mkdir(runPath, { recursive: true });
  let replica;
  let client;
  let server;
  let browser;
  let scopedDb;
  let ready = false;
  let serverExited = false;
  try {
    replica = new MongoMemoryReplSet({
      binary: { version: '7.0.24', downloadDir: process.env.MONGOMS_DOWNLOAD_DIR },
      replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger', spawn: { windowsHide: true }, args: ['--wiredTigerCacheSizeGB', '0.25', '--oplogSize', '16'] },
      instanceOpts: [{ dbPath: runPath }],
    });
    await replica.start();
    const uri = replica.getUri();
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, 'Only the freshly started local replica is allowed.');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    Object.assign(process.env, {
      MONGODB_URI: uri, MONGODB_DB_NAME: 'owner_recovery_acceptance', MONGODB_COLLECTION_PREFIX: prefix,
      MONGODB_USERNAME: '', MONGODB_PASSWORD: '', NODE_ENV: 'production',
      AUTH_SECRET: randomBytes(40).toString('hex'), IDENTITY_LOOKUP_SECRET: randomBytes(40).toString('hex'),
      PAYMENT_WEBHOOK_SECRET: randomBytes(40).toString('hex'), SITE_URL: base,
    });
    // Load the real TypeScript operations only after replacing all database configuration.
    require('tsx/cjs');
    const { getDb, getMongoClient } = require('../lib/db.ts');
    const { hashPassword } = require('../lib/auth.ts');
    const { resetOwnerForRecovery } = require('../lib/owner-reset.ts');
    client = await getMongoClient();
    scopedDb = await getDb();
    assert.equal(await scopedDb.collection('users').countDocuments({}), 0);
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
    });
    // Do not echo server diagnostics: application failures might contain credentials.
    server.stdout.on('data', chunk => { if (String(chunk).includes('Ready')) ready = true; });
    server.stderr.on('data', () => {});
    server.once('exit', () => { serverExited = true; });
    server.once('error', () => { serverExited = true; });
    for (let attempt = 0; attempt < 90 && !ready; attempt += 1) {
      if (serverExited) throw new Error('The isolated production-build server could not start.');
      await sleep(500);
    }
    assert.ok(ready, 'The isolated production-build server must become ready.');

    async function request(endpoint, { method = 'GET', body, rawBody, cookie = '', expected = 200, origin = base, contentType = 'application/json' } = {}) {
      const response = await fetch(`${base}${endpoint}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { cookie, origin, 'content-type': contentType },
        ...(rawBody === undefined ? (body === undefined ? {} : { body: JSON.stringify(body) }) : { body: rawBody }),
      });
      const payload = await response.json();
      if (expected !== null) assert.equal(response.status, expected, `${method} ${endpoint}: ${payload.error || 'unexpected status'}`);
      assert.equal(payload.ok, response.status < 400);
      assert.match(response.headers.get('cache-control') || '', /no-store/);
      const cookieHeader = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      return { status: response.status, data: payload.data, payload, cookie: cookieHeader };
    }
    const recoveryRequest = (body, expected = 200, options = {}) => request('/api/owner-recovery', { method: 'POST', body, expected, ...options });
    const inspect = (token, expected = 200) => recoveryRequest({ action: 'INSPECT', token }, expected);
    const ownerPassword = strongPassword();
    const ownerInput = {
      businessName: 'Recovery Test Matcha', fullName: 'Original Test Owner', username: 'original.owner', email: 'owner@recovery.example',
      password: ownerPassword, seedProducts: false, countryCode: 'MY', currency: 'MYR', acceptedCurrencies: ['MYR'],
      locale: 'en-MY', timeZone: 'Asia/Kuala_Lumpur', taxName: 'Test tax', taxRate: 0, taxMode: 'EXCLUSIVE',
    };
    const initial = await request('/api/setup', { method: 'POST', body: ownerInput, expected: 201 });
    const oldOwner = await scopedDb.collection('users').findOne({ usernameNormalized: ownerInput.username });
    assert.ok(oldOwner);
    const adminPassword = strongPassword();
    const adminId = new ObjectId();
    const otherId = new ObjectId();
    const now = new Date();
    const admin = {
      _id: adminId, username: 'admin', usernameNormalized: 'admin', fullName: 'Preserved Test Admin',
      email: 'admin@recovery.example', emailNormalized: 'admin@recovery.example', passwordHash: await hashPassword(adminPassword),
      role: 'ADMIN', active: true, sessionVersion: 1, mustChangePassword: false, createdAt: now, updatedAt: now,
    };
    await scopedDb.collection('users').insertMany([admin, { ...admin, _id: otherId, username: 'other.admin', usernameNormalized: 'other.admin', email: 'other@recovery.example', emailNormalized: 'other@recovery.example' }]);
    const adminSession = await request('/api/auth/login', { method: 'POST', body: { identity: 'admin', password: adminPassword } });
    const adminBefore = await scopedDb.collection('users').findOne({ _id: adminId });
    const otherBefore = await scopedDb.collection('users').findOne({ _id: otherId });
    const settingsBefore = await scopedDb.collection('settings').findOne({ key: 'business' });
    const controlBefore = await scopedDb.collection('systemControls').findOne({ _id: 'workspace' });
    const setupLockBefore = await scopedDb.collection('systemLocks').findOne({ _id: 'owner-setup' });
    const journal = {
      _id: new ObjectId(), entryNo: 'TEST-RECOVERY-JOURNAL', memo: 'Preserve this historical ledger',
      createdBy: oldOwner._id, totalDebit: 125.5, totalCredit: 125.5, createdAt: now,
      lines: [{ accountCode: '1000', debit: 125.5, credit: 0 }, { accountCode: '3000', debit: 0, credit: 125.5 }],
    };
    await scopedDb.collection('journalEntries').insertOne(journal);
    const product = { _id: new ObjectId(), sku: 'RECOVERY-KEEP', name: 'Preserved Matcha', stock: 7, createdBy: oldOwner._id, createdAt: now };
    await scopedDb.collection('products').insertOne(product);
    const oldScannerToken = randomBytes(32).toString('hex');
    const adminScannerToken = randomBytes(32).toString('hex');
    const oldDisplayToken = randomBytes(32).toString('hex');
    const adminDisplayToken = randomBytes(32).toString('hex');
    const future = new Date(Date.now() + 3_600_000);
    const link = (ownerId, token) => ({ _id: new ObjectId(), tokenHash: tokenHash(token), createdBy: ownerId, createdAt: now, updatedAt: now, expiresAt: future, generation: controlBefore.scannerGeneration });
    const oldScanner = { ...link(oldOwner._id, oldScannerToken), purpose: 'POS', label: 'Old Owner scanner' };
    const adminScanner = { ...link(adminId, adminScannerToken), purpose: 'POS', label: 'Preserved admin scanner' };
    const oldDisplay = { ...link(oldOwner._id, oldDisplayToken), phase: 'PAYMENT', amount: 25, currency: 'MYR', qrPayload: 'TEST-OLD-QR', stateVersion: 1 };
    const adminDisplay = { ...link(adminId, adminDisplayToken), phase: 'WELCOME', stateVersion: 1 };
    await scopedDb.collection('scannerSessions').insertMany([oldScanner, adminScanner]);
    await scopedDb.collection('paymentDisplaySessions').insertMany([oldDisplay, adminDisplay]);
    const transfers = [
      { _id: new ObjectId(), fromUserId: oldOwner._id, targetUserId: adminId, status: 'PENDING', createdAt: now },
      { _id: new ObjectId(), fromUserId: adminId, targetUserId: oldOwner._id, status: 'PENDING', createdAt: now },
      { _id: new ObjectId(), fromUserId: adminId, targetUserId: otherId, status: 'PENDING', createdAt: now },
      { _id: new ObjectId(), fromUserId: oldOwner._id, targetUserId: adminId, status: 'COMPLETED', createdAt: now },
    ];
    await scopedDb.collection('ownershipTransfers').insertMany(transfers);
    pass('isolated Owner, admin, ledger and owner-scoped link fixtures');

    // Reset refuses pending ownership changes instead of racing their completion.
    await assert.rejects(resetOwnerForRecovery(scopedDb, client, oldOwner._id.toHexString()));
    assert.deepEqual(await scopedDb.collection('users').findOne({ _id: oldOwner._id }), oldOwner);
    assert.equal(await scopedDb.collection('ownerRecovery').countDocuments({}), 0);
    assert.deepEqual(await scopedDb.collection('scannerSessions').findOne({ _id: oldScanner._id }), oldScanner);
    for (const transfer of transfers.filter(value => value.status === 'PENDING')) {
      transfer.status = 'CANCELLED';
      transfer.cancelledAt = new Date();
      await scopedDb.collection('ownershipTransfers').updateOne({ _id: transfer._id }, { $set: { status: transfer.status, cancelledAt: transfer.cancelledAt } });
    }
    pass('reset refuses pending ownership transfers without changing account or capabilities');

    const grant = await resetOwnerForRecovery(scopedDb, client, oldOwner._id.toHexString());
    assert.match(grant.token, /^[a-f0-9]{64}$/i);
    assert.equal(String(grant.removedOwnerId), oldOwner._id.toHexString());
    assert.equal(await scopedDb.collection('users').countDocuments({ role: 'OWNER' }), 0);
    assert.equal(await scopedDb.collection('users').findOne({ _id: oldOwner._id }), null);
    assert.deepEqual(await scopedDb.collection('users').findOne({ _id: adminId }), adminBefore);
    assert.deepEqual(await scopedDb.collection('users').findOne({ _id: otherId }), otherBefore);
    assert.deepEqual(await scopedDb.collection('settings').findOne({ key: 'business' }), settingsBefore);
    assert.deepEqual(await scopedDb.collection('systemControls').findOne({ _id: 'workspace' }), controlBefore);
    assert.deepEqual(await scopedDb.collection('systemLocks').findOne({ _id: 'owner-setup' }), setupLockBefore);
    assert.deepEqual(await scopedDb.collection('journalEntries').findOne({ _id: journal._id }), journal);
    assert.deepEqual(await scopedDb.collection('products').findOne({ _id: product._id }), product);
    for (const transfer of transfers) assert.deepEqual(await scopedDb.collection('ownershipTransfers').findOne({ _id: transfer._id }), transfer);
    assert.equal(await scopedDb.collection('archivedUsers').countDocuments({}), 1);
    for (const [collection, removed, preserved] of [['scannerSessions', oldScanner, adminScanner], ['paymentDisplaySessions', oldDisplay, adminDisplay]]) {
      assert.ok((await scopedDb.collection(collection).findOne({ _id: removed._id })).revokedAt instanceof Date);
      assert.deepEqual(await scopedDb.collection(collection).findOne({ _id: preserved._id }), preserved);
    }
    // Search only this run's isolated collections for the removed account hash/token.
    // The old password hash must not survive in an account archive or audit log.
    const collectionNames = await client.db(process.env.MONGODB_DB_NAME).listCollections({ name: { $regex: `^${prefix}` } }).toArray();
    for (const collection of collectionNames) {
      const documents = await client.db(process.env.MONGODB_DB_NAME).collection(collection.name).find({}).toArray();
      const serialized = JSON.stringify(documents);
      assert.ok(!serialized.includes(oldOwner.passwordHash), 'Removed Owner password hash must not be archived.');
      assert.ok(!serialized.includes(grant.token), 'Only a hash of the recovery token may be persisted.');
    }
    const savedGrant = await scopedDb.collection('ownerRecovery').findOne({ _id: 'owner-recovery' });
    assert.equal(savedGrant.tokenHash, tokenHash(grant.token));
    assert.equal(savedGrant.status, 'PENDING');
    pass('exact Owner removed; admins, historical actor IDs, ledger and settings preserved; scoped links revoked');
    await request('/api/settings', { cookie: initial.cookie, expected: 401 });
    await request('/api/settings', { cookie: adminSession.cookie });
    await request('/api/auth/login', { method: 'POST', body: { identity: ownerInput.username, password: ownerPassword }, expected: 401 });
    const closedSetup = await request('/api/setup');
    assert.equal(closedSetup.data.configured, true);
    assert.equal(closedSetup.data.registrationOpen, false);
    await request('/api/setup', { method: 'POST', body: ownerInput, expected: 409 });
    await request('/api/mobile-scans', { method: 'POST', body: { action: 'CONNECT', token: oldScannerToken }, expected: 410 });
    await request('/api/mobile-scans', { method: 'POST', body: { action: 'CONNECT', token: adminScannerToken } });
    await request('/api/payment-display', { method: 'POST', body: { action: 'POLL', token: oldDisplayToken }, expected: 410 });
    await request('/api/payment-display', { method: 'POST', body: { action: 'POLL', token: adminDisplayToken } });
    pass('old Owner login/session and links rejected; admin and normal setup protection retained');

    const invalid = await inspect(randomBytes(32).toString('hex'), 410);
    assert.equal(invalid.data, undefined);
    assert.ok(!JSON.stringify(invalid.payload).includes(settingsBefore.businessName));
    await recoveryRequest({ action: 'INSPECT', token: 'bad' }, 422);
    await recoveryRequest({ action: 'INSPECT', token: grant.token }, 403, { origin: 'https://untrusted.example' });
    await request('/api/owner-recovery', { method: 'POST', rawBody: '{', expected: 400 });
    await request('/api/owner-recovery', { method: 'POST', rawBody: '{}', contentType: 'text/plain', expected: 415 });
    await request('/api/owner-recovery', { method: 'POST', rawBody: ' '.repeat(17 * 1024), expected: 413 });
    const details = await inspect(grant.token);
    assert.deepEqual(Object.keys(details.data).sort(), ['businessName', 'expiresAt']);
    assert.equal(details.data.businessName, settingsBefore.businessName);
    await scopedDb.collection('ownerRecovery').updateOne({ _id: 'owner-recovery' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await inspect(grant.token, 410);
    await scopedDb.collection('ownerRecovery').updateOne({ _id: 'owner-recovery' }, { $set: { expiresAt: savedGrant.expiresAt, status: 'CONSUMED' } });
    await inspect(grant.token, 410);
    await scopedDb.collection('ownerRecovery').updateOne({ _id: 'owner-recovery' }, { $set: { status: 'CANCELLED' } });
    await inspect(grant.token, 410);
    await scopedDb.collection('ownerRecovery').updateOne({ _id: 'owner-recovery' }, { $set: { status: 'PENDING' } });
    const claim = { action: 'CLAIM', token: grant.token, fullName: 'Replacement Test Owner', username: 'replacement.owner', email: 'replacement@recovery.example', password: strongPassword() };
    await recoveryRequest({ ...claim, password: 'admin123' }, 422);
    await recoveryRequest({ ...claim, password: `Strong9${'é'.repeat(40)}` }, 422);
    await recoveryRequest({ ...claim, username: 'admin' }, 409);
    await recoveryRequest({ ...claim, email: admin.email }, 409);
    assert.equal((await scopedDb.collection('ownerRecovery').findOne({ _id: 'owner-recovery' })).status, 'PENDING');
    assert.equal(await scopedDb.collection('users').countDocuments({ role: 'OWNER' }), 0);
    pass('invalid/expired/used grants, origin, body limits and password policy; duplicate identity rolls back consumption');

    const parallelClaims = [claim, { ...claim, username: 'competing.owner', email: 'competing@recovery.example', password: strongPassword() }];
    const claimResults = await Promise.all(parallelClaims.map(body => recoveryRequest(body, null)));
    assert.deepEqual(claimResults.map(result => result.status).sort(), [201, 410]);
    assert.equal(await scopedDb.collection('users').countDocuments({ role: 'OWNER' }), 1);
    assert.equal((await scopedDb.collection('ownerRecovery').findOne({ _id: 'owner-recovery' })).status, 'CONSUMED');
    const winnerIndex = claimResults.findIndex(result => result.status === 201);
    const winner = parallelClaims[winnerIndex];
    const winnerLogin = await request('/api/auth/login', { method: 'POST', body: { identity: winner.username, password: winner.password } });
    assert.equal(winnerLogin.data.user.role, 'OWNER');
    await inspect(grant.token, 410);
    await recoveryRequest(claim, 410);
    assert.deepEqual(await scopedDb.collection('journalEntries').findOne({ _id: journal._id }), journal);
    pass('competing real HTTP claims create exactly one Owner; replay denied; resulting Owner login succeeds');

    // Issue another isolated grant to exercise the complete user-driven page flow.
    const replacement = await scopedDb.collection('users').findOne({ role: 'OWNER' });
    const browserGrant = await resetOwnerForRecovery(scopedDb, client, replacement._id.toHexString());
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // A genuine but now-deleted Owner cookie must not redirect away from recovery.
    const [cookieName, ...cookieValue] = winnerLogin.cookie.split(';')[0].split('=');
    await context.addCookies([{ name: cookieName, value: cookieValue.join('='), url: base, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const browserErrors = [];
    const browserRequests = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('request', request => browserRequests.push(request.url()));
    await page.goto(`${base}/recover-owner#token=${browserGrant.token}`);
    await page.locator('input[name="username"]').waitFor();
    assert.ok(page.url().includes('/recover-owner'), 'A deleted Owner cookie cannot block the recovery page.');
    const browserPassword = strongPassword();
    await page.locator('input[name="fullName"]').fill('Browser Replacement Owner');
    await page.locator('input[name="username"]').fill('browser.owner');
    await page.locator('input[name="email"]').fill('browser@recovery.example');
    await page.locator('input[name="password"]').fill(browserPassword);
    const confirmation = page.locator('input[name="confirmPassword"]');
    if (await confirmation.count()) await confirmation.fill(browserPassword);
    const acknowledgements = page.locator('input[type="checkbox"][required]');
    for (let index = 0; index < await acknowledgements.count(); index += 1) await acknowledgements.nth(index).check();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, 'Recovery form must fit a mobile viewport.');
    const claimResponse = page.waitForResponse(response => response.url().endsWith('/api/owner-recovery') && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'CLAIM');
    await page.locator('button[type="submit"]').click();
    assert.equal((await claimResponse).status(), 201);
    await page.waitForURL(url => ['/dashboard', '/login'].includes(url.pathname));
    assert.ok(browserRequests.every(url => !url.includes(browserGrant.token)), 'Recovery token must stay out of network URLs.');
    assert.deepEqual(browserErrors, []);
    await context.close();
    const browserLogin = await request('/api/auth/login', { method: 'POST', body: { identity: 'browser.owner', password: browserPassword } });
    assert.equal(browserLogin.data.user.role, 'OWNER');
    assert.equal(await scopedDb.collection('users').countDocuments({ role: 'OWNER' }), 1);
    assert.deepEqual(await scopedDb.collection('journalEntries').findOne({ _id: journal._id }), journal);
    assert.deepEqual(await scopedDb.collection('settings').findOne({ key: 'business' }), settingsBefore);
    assert.deepEqual(await scopedDb.collection('users').findOne({ _id: adminId }), adminBefore);
    pass('real mobile browser recovery with stale Owner cookie, fragment-only capability and subsequent Owner login');
    pass('owner recovery end-to-end regression; no production services used');
  } finally {
    await browser?.close();
    if (server && !serverExited) {
      server.kill();
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(5_000)]);
    }
    await client?.close();
    await replica?.stop({ doCleanup: false });
    const actualRoot = await fs.realpath(runtimeRoot);
    const actualRun = await fs.realpath(runPath);
    assert.equal(path.dirname(actualRun), actualRoot, 'Cleanup must stay within the test runtime.');
    assert.match(path.basename(actualRun), /^owner-run-[a-f0-9]{16}$/);
    await fs.rm(actualRun, { recursive: true });
    console.log('CLEANUP removed only this run’s local temporary database; no business collections were accessed.');
  }
}

main().catch(error => {
  // Never print assertion actual/expected objects: those can contain generated credentials.
  console.error(String(error instanceof Error ? error.message : 'Owner recovery regression failed').replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[redacted database URI]'));
  process.exitCode = 1;
});
