const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createCipheriv, createHmac, createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');

module.exports = async function ({ api, collection, base, cookie, env, product }) {
  assert.match(env.MONGODB_DB_NAME, /^konkon_qa_commerce_/);
  const settings = await api('/api/settings');
  const settingsCount = await collection('settingsHistory').countDocuments({});
  const settingsAudits = await collection('auditLogs').countDocuments({ action: 'settings.update' });
  await api('/api/settings', 'PATCH', settings);
  assert.equal(await collection('settingsHistory').countDocuments({}), settingsCount);
  assert.equal(await collection('auditLogs').countDocuments({ action: 'settings.update' }), settingsAudits);
  const scanner = await collection('scannerSessions').findOne({ purpose: { $ne: 'MEMBER_BIND' }, expiresAt: { $gt: new Date() }, revokedAt: { $exists: false } });
  if (scanner) {
    const routeAudits = await collection('auditLogs').countDocuments({ action: 'scanner.route' });
    await api('/api/scanner-sessions', 'PATCH', { id: scanner._id.toHexString(), purpose: scanner.purpose });
    assert.equal(await collection('auditLogs').countDocuments({ action: 'scanner.route' }), routeAudits);
  }
  const memberBody = { name: 'Deletion regression member', phone: '+60160000001', email: 'deletion@test.example', identityNumber: 'DELETION1234', identityType: 'NATIONAL_ID' };
  const member = await api('/api/members', 'POST', memberBody, 201);
  const cardBody = { memberId: member._id, clientRequestId: randomUUID(), label: 'Deletion test card', tier: 'MATCHA CLUB', accentColor: '#173f2a' };
  const card = await api('/api/member-cards', 'POST', cardBody, 201);
  const { token } = await api('/api/member-cards', 'POST', { action: 'REVEAL', id: card._id });
  const bound = await api('/api/member-cards', 'POST', { ...cardBody, action: 'BIND', code: `KKNT1-S-${randomBytes(32).toString('hex')}`, clientRequestId: randomUUID() }, 201);
  const sale = await api('/api/sales', 'POST', { clientRequestId: randomUUID(), paymentMethod: 'CASH', tenderedAmount: 100, memberId: member._id, items: [{ productId: product._id, quantity: 1 }] }, 201);
  const saleBefore = await collection('sales').findOne({ _id: new ObjectId(sale._id) });
  await api('/api/members', 'DELETE', { id: member._id });
  await api(`/api/members?id=${member._id}`, 'GET', undefined, 404);
  await api('/api/members', 'PATCH', { id: member._id, name: 'Must not return' }, 404);
  await api('/api/member-cards/lookup', 'POST', { code: token }, 410);
  await api('/api/member-cards', 'POST', { action: 'REVEAL', id: card._id }, 410);
  const tombstone = await collection('members').findOne({ _id: new ObjectId(member._id) });
  for (const field of ['phone', 'email', 'identityLookupHash', 'identityLast4', 'identityType', 'memberCardCode']) assert.equal(tombstone[field], undefined, `Member ${field} erased`);
  assert.ok(tombstone.personalDataClearedAt); assert.equal(tombstone.name, 'Deleted member');
  const oldCard = await collection('memberCards').findOne({ _id: new ObjectId(card._id) });
  assert.equal(oldCard.status, 'VOID'); assert.equal(oldCard.encryptedToken, undefined); assert.equal(oldCard.tokenHash, undefined);
  const replacement = await api('/api/members', 'POST', memberBody, 201); assert.notEqual(replacement._id, member._id);
  assert.equal((await api('/api/members?identity=DELETION1234'))[0]._id, replacement._id);
  assert.deepEqual(await collection('sales').findOne({ _id: saleBefore._id }), saleBefore, 'Financial snapshot untouched by deletion');
  // Older orphan cards must not disappear behind more than 100 live cards.
  const fixtures = Array.from({ length: 101 }, () => ({ _id: new ObjectId(), memberId: new ObjectId(replacement._id), kind: 'BOUND', status: 'ACTIVE', clientRequestId: randomUUID(), updatedAt: new Date(Date.now() + 1000) }));
  await collection('memberCards').insertMany(fixtures);
  try { assert.ok((await api('/api/member-cards?orphaned=1')).some(row => row._id === bound._id)); }
  finally { await collection('memberCards').deleteMany({ _id: { $in: fixtures.map(row => row._id) } }); }
  await api('/api/member-cards', 'POST', { action: 'CLEAR_ORPHAN', id: bound._id });
  assert.ok(!(await api(`/api/member-cards?memberId=${member._id}`)).some(row => row._id === bound._id));
  // Competing requests cannot leave a usable issued credential after deletion.
  const racing = await api('/api/members', 'POST', { name: 'Concurrent deletion', phone: '+60160000002' }, 201);
  await Promise.all([api('/api/member-cards', 'POST', { ...cardBody, memberId: racing._id, clientRequestId: randomUUID() }, [201, 410]), api('/api/members', 'DELETE', { id: racing._id })]);
  assert.equal(await collection('memberCards').countDocuments({ memberId: new ObjectId(racing._id), $or: [{ status: 'ACTIVE' }, { encryptedToken: { $exists: true } }] }), 0);
  console.log('PASS member deletion: contacts/ID reuse, credential revocation, historical sale preservation, >100-card orphan lookup, delete/issue race.');

  const userBody = { fullName: 'Deletion regression staff', username: 'delete_staff', email: 'delete_staff@test.example', role: 'CASHIER', password: 'OnlyForIsolatedTest123!' };
  const user = await api('/api/users', 'POST', userBody, 201);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: userBody.username, password: userBody.password }) });
  assert.equal(login.status, 200); const oldCookie = login.headers.get('set-cookie').split(';')[0];
  const deviceIds = [new ObjectId(), new ObjectId()];
  for (const [i, name] of ['scannerSessions', 'paymentDisplaySessions'].entries()) await collection(name).insertOne({ _id: deviceIds[i], tokenHash: randomBytes(32).toString('hex'), createdBy: new ObjectId(user._id), expiresAt: new Date(Date.now() + 86400000) });
  await api('/api/users', 'DELETE', { id: user._id });
  assert.ok(!(await api('/api/users')).users.some(row => row._id === user._id));
  await api('/api/users', 'PATCH', { id: user._id, active: true }, 404);
  await api('/api/users', 'PATCH', { id: user._id, action: 'RESET_PASSWORD' }, 404);
  const erasedUser = await collection('users').findOne({ _id: new ObjectId(user._id) });
  for (const field of ['email', 'emailNormalized', 'passwordHash']) assert.equal(erasedUser[field], undefined);
  for (const [i, name] of ['scannerSessions', 'paymentDisplaySessions'].entries()) { const device = await collection(name).findOne({ _id: deviceIds[i] }); assert.ok(!device || device.revokedAt && device.expiresAt <= new Date()); }
  assert.equal((await fetch(base + '/api/members', { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: userBody.username, password: userBody.password }) })).status, 401);
  assert.notEqual((await api('/api/users', 'POST', userBody, 201))._id, user._id);
  const owner = await collection('users').findOne({ username: 'testowner' });
  await api('/api/users', 'DELETE', { id: owner._id.toHexString() }, 409);
  console.log('PASS staff deletion: name/email reuse, old login/session invalid, devices revoked, reactivation/reset denied, Owner protected.');

  // Dry-run must be non-mutating, even when malformed financial records have an expiry field.
  const past = new Date(Date.now() - 120 * 86400000), future = new Date(Date.now() + 86400000);
  const expired = new ObjectId(), live = new ObjectId();
  await collection('scannerEvents').insertMany([{ _id: expired, expiresAt: past }, { _id: live, expiresAt: future, encryptedCode: 'not-consumed' }]);
  const legacyMember = await collection('members').insertOne({ memberNo: randomUUID(), name: 'Legacy archived', phone: '+60160000003', active: false, archivedAt: past });
  const legacyUser = await collection('users').insertOne({ usernameNormalized: 'legacy-delete-staff', fullName: 'Legacy archived staff', passwordHash: 'old-hash', emailNormalized: 'old@test.example', role: 'CASHIER', active: false, archivedAt: past });
  const log = await collection('auditLogs').insertOne({ action: 'auth.login', createdAt: past });
  const protectedAudit = await collection('auditLogs').insertOne({ action: 'sale.create', createdAt: past, expiresAt: past });
  const financial = ['sales', 'refunds', 'journalEntries', 'paymentConfirmations', 'settingsHistory'];
  const protectedRows = [];
  for (const name of financial) protectedRows.push([name, await collection(name).insertOne({ testMarker: 'retention-protected', expiresAt: past })]);
  // Make a valid legacy, uncompressed encrypted artifact, using the production format.
  const source = await collection('eInvoices').findOne({ encryptedContent: { $exists: true } });
  assert.ok(source, 'Existing e-invoice fixture');
  const sourceUrl = `/api/e-invoices?sourceType=${source.sourceType}&sourceId=${source.sourceId}&id=${source._id}`;
  const original = await (await fetch(base + sourceUrl, { headers: { Cookie: cookie() } })).text();
  assert.equal(createHash('sha256').update(original).digest('hex'), source.sha256);
  const iv = randomBytes(12), key = createHmac('sha256', env.AUTH_SECRET).update('konkon-member-card-encryption-v1').digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(`einvoice:${source._id}`));
  const bytes = Buffer.concat([cipher.update(original, 'utf8'), cipher.final()]);
  const legacyEncrypted = [iv, cipher.getAuthTag(), bytes].map(value => value.toString('base64url')).join('.');
  await collection('eInvoices').updateOne({ _id: source._id }, { $set: { encryptedContent: legacyEncrypted }, $unset: { contentEncoding: '' } });
  const preview = await api('/api/maintenance'); assert.equal(preview.dryRun, true); assert.ok(preview.clearedProfiles >= 2); assert.ok(preview.packedDocuments >= 1);
  assert.equal((await collection('members').findOne({ _id: legacyMember.insertedId })).phone, '+60160000003');
  assert.equal((await collection('eInvoices').findOne({ _id: source._id })).encryptedContent, legacyEncrypted);
  await api('/api/maintenance', 'GET', undefined, 401, false);
  assert.equal((await fetch(base + '/api/maintenance', { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal((await fetch(base + '/api/maintenance', { method: 'POST', headers: { Cookie: cookie(), Origin: 'https://untrusted.example' } })).status, 403);
  await collection('users').updateOne({ _id: owner._id }, { $set: { role: 'ADMIN' } });
  try { await api('/api/maintenance', 'POST', {}, 403); await api('/api/maintenance', 'GET', undefined, 403); }
  finally { await collection('users').updateOne({ _id: owner._id }, { $set: { role: 'OWNER' } }); }
  const run = await api('/api/maintenance', 'POST', {}); assert.equal(run.dryRun, false); assert.ok(run.clearedProfiles >= 2);
  assert.equal(await collection('scannerEvents').countDocuments({ _id: expired }), 0); assert.equal(await collection('scannerEvents').countDocuments({ _id: live }), 1);
  assert.equal((await collection('members').findOne({ _id: legacyMember.insertedId })).phone, undefined);
  assert.equal((await collection('users').findOne({ _id: legacyUser.insertedId })).passwordHash, undefined);
  const oldLog = await collection('auditLogs').findOne({ _id: log.insertedId }); assert.ok(!oldLog || oldLog.expiresAt instanceof Date);
  assert.equal(await collection('auditLogs').countDocuments({ _id: protectedAudit.insertedId }), 1);
  for (const [name, result] of protectedRows) assert.equal(await collection(name).countDocuments({ _id: result.insertedId }), 1, `${name} retained`);
  assert.deepEqual(await collection('sales').findOne({ _id: saleBefore._id }), saleBefore);
  const migrated = await collection('eInvoices').findOne({ _id: source._id }); assert.ok(migrated.contentEncoding);
  assert.equal(await (await fetch(base + sourceUrl, { headers: { Cookie: cookie() } })).text(), original);
  const cron = await fetch(base + '/api/maintenance?dryRun=1', { headers: { Authorization: `Bearer ${env.CRON_SECRET}` } });
  assert.equal(cron.status, 200); assert.equal((await cron.json()).data.dryRun, true);
  assert.equal((await api('/api/maintenance', 'POST', {})).clearedProfiles, 0, 'Cleanup is repeat-safe');
  console.log(`PASS maintenance: Owner/cron-only, cross-origin blocked, dry-run unchanged, legacy cleanup, financial evidence retained, encrypted export round-trip (${run.savedBytes} bytes saved in fixture).`);
};
