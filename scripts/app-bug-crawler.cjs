const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const SEEDS = ['/dashboard', '/pos', '/counters', '/coupons', '/payments', '/receipts', '/members', '/inventory', '/procurement', '/accounting', '/invoices', '/reports', '/team', '/locations', '/settings'];
const SKIP = /^\/(?:api|downloads|scan|pay-display|card-write|recover-owner|setup|change-password)(?:\/|$)/;

module.exports = async function crawlApp({ page, base, output }) {
  const origin = new URL(base).origin;
  const queue = [...SEEDS];
  const seen = new Set();
  const failures = [];
  const onPageError = error => failures.push({ type: 'page-error', message: error.message });
  const onResponse = response => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 500) failures.push({ type: 'server-error', status: response.status(), url: url.pathname });
  };
  page.on('pageerror', onPageError); page.on('response', onResponse);
  try {
    await fs.mkdir(output, { recursive: true });
    while (queue.length && seen.size < 40) {
      const pathname = queue.shift();
      if (!pathname || seen.has(pathname) || SKIP.test(pathname)) continue;
      seen.add(pathname);
      const response = await page.goto(origin + pathname, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert.ok(response && response.status() < 400, `${pathname} returned ${response?.status() || 'no response'}`);
      await page.waitForTimeout(350);
      assert.notEqual(new URL(page.url()).pathname, '/login', `${pathname} unexpectedly signed the crawler out`);
      if (pathname === '/counters' || pathname === '/team') {
        await page.locator('.loading-panel').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        await page.screenshot({ path: path.join(output, `${pathname.slice(1)}-responsive.png`), fullPage: true });
      }
      const links = await page.locator('a[href]').evaluateAll((anchors, expectedOrigin) => anchors.map(anchor => {
        try { const url = new URL(anchor.href); return url.origin === expectedOrigin ? url.pathname : ''; } catch { return ''; }
      }), origin);
      for (const link of links) if (link && !seen.has(link) && !SKIP.test(link)) queue.push(link);
    }
    await fs.writeFile(path.join(output, 'bug-crawler-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), pages: [...seen], failures }, null, 2));
    assert.deepEqual(failures, []);
    console.log(`PASS read-only bug crawler checked ${seen.size} authenticated pages with no broken route, page crash or 5xx response.`);
  } finally {
    page.off('pageerror', onPageError); page.off('response', onResponse);
  }
};
