// Development-only runner: real MongoDB transactions without any Atlas credentials.
// Install the optional test tool under .artifacts/regional-mongo; never a production dependency.
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

async function main() {
  if (!process.argv[2]) throw new Error('Pass the directory containing the optional Playwright package.');
  const root = path.resolve('.artifacts/regional-mongo');
  process.env.MONGOMS_DOWNLOAD_DIR = path.join(root, 'binaries');
  const { MongoMemoryReplSet } = require(path.join(root, 'node_modules/mongodb-memory-server'));
  const runName = `run-${randomBytes(8).toString('hex')}`;
  const dbPath = path.join(root, runName);
  await fs.mkdir(dbPath, { recursive: true });
  let replica;
  try {
    replica = new MongoMemoryReplSet({
      binary: { version: '7.0.24', downloadDir: process.env.MONGOMS_DOWNLOAD_DIR },
      replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger', spawn: { windowsHide: true }, args: ['--wiredTigerCacheSizeGB', '0.25', '--oplogSize', '16'] },
      instanceOpts: [{ dbPath }],
    });
    await replica.start();
    console.log('Ready: isolated local replica set; no production database credentials used.');
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/regional-smoke.ts', process.argv[2]], {
      windowsHide: true, stdio: 'inherit',
      env: { ...process.env, MONGODB_URI: replica.getUri(), MONGODB_DB_NAME: 'regional_acceptance', MONGODB_USERNAME: '', MONGODB_PASSWORD: '' },
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error('Local regional acceptance checks failed.');
  } finally {
    await replica?.stop({ doCleanup: false });
    const resolvedRoot = await fs.realpath(root);
    const resolvedDb = await fs.realpath(dbPath);
    if (path.dirname(resolvedDb) !== resolvedRoot || !/^run-[a-f0-9]{16}$/.test(path.basename(resolvedDb))) throw new Error('Unsafe temporary database cleanup target.');
    await fs.rm(resolvedDb, { recursive: true });
    console.log('CLEANUP removed this run’s temporary local database files.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
