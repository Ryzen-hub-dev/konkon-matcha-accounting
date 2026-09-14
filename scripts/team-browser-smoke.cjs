// Render the actual Team component and CSS; HTTP fixtures exercise responsive controls.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const component = path.resolve('components/team-view.tsx').replaceAll('\\', '/');
  const { outputFiles } = await require('esbuild').build({
    stdin: { contents: `import {createRoot} from 'react-dom/client'; import {TeamView} from ${JSON.stringify(component)}; createRoot(document.getElementById('root')).render(<main className="main-content"><TeamView actorRole="OWNER" /></main>);`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const css = await fs.readFile('app/globals.css', 'utf8');
  const output = path.resolve('.artifacts/team-qa'); await fs.mkdir(output, { recursive: true });
  const { chromium } = require(path.join(process.argv[2], 'playwright'));
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const width of [320, 390, 768, 1024, 1360]) {
      const users = [{ _id: 'owner', fullName: 'Konkon Owner', username: 'owner', role: 'OWNER', active: true }, { _id: 'staff', fullName: 'Alexandria Long Staff Name 测试员工', username: 'long.staff_account_1234567890', email: 'long.staff.account.for.responsive.testing@konkon.example', role: 'CASHIER', active: true }];
      const writes = [], errors = [];
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 900 });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: outputFiles[0].text });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css', body: css });
        if (url.pathname === '/api/users') {
          const body = req.method() === 'GET' ? {} : req.postDataJSON();
          let data = { users, audit: [{ _id: 'audit', actorName: 'Konkon Owner', action: 'user.password_reset', entityType: 'user', createdAt: '2026-09-14T01:00:00Z' }] };
          if (req.method() !== 'GET') writes.push({ method: req.method(), ...body });
          if (req.method() === 'POST') { users.push({ _id: 'new', ...body, active: true }); data = users.at(-1); }
          if (req.method() === 'PATCH') { const user = users.find(user => user._id === body.id); Object.assign(user, body); data = body.action === 'RESET_PASSWORD' ? { temporaryPassword: 'OnlyForUiTest123!' } : user; }
          if (req.method() === 'DELETE') { users.splice(users.findIndex(user => user._id === body.id), 1); data = { deleted: true }; }
          return route.fulfill({ status: req.method() === 'POST' ? 201 : 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
        }
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
      });
      const activate = locator => width < 900 ? locator.tap() : locator.click();
      await page.goto('http://team-qa.test/');
      const staff = page.getByRole('article', { name: 'Account long.staff_account_1234567890', exact: true });
      await staff.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}: no page overflow`);
      await page.screenshot({ path: path.join(output, `team-${width}.png`), fullPage: true });
      for (const button of await staff.getByRole('button').all()) {
        await button.scrollIntoViewIfNeeded();
        assert.equal(await button.evaluate(el => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.height >= 44 && r.left >= 0 && r.right <= innerWidth && (el === hit || el.contains(hit)); }), true, `${width}: button hit target`);
      }
      await staff.getByRole('combobox').selectOption('MANAGER'); await page.waitForFunction(() => document.querySelector('.team-row select')?.value === 'MANAGER');
      await activate(staff.getByRole('button', { name: 'Disable', exact: true })); await staff.getByRole('button', { name: 'Enable', exact: true }).waitFor();
      await activate(staff.getByRole('button', { name: 'Enable', exact: true })); await staff.getByRole('button', { name: 'Disable', exact: true }).waitFor();
      await activate(staff.getByRole('button', { name: 'Reset password', exact: true }));
      const ready = page.getByRole('dialog', { name: 'Account ready', exact: true }); await ready.getByText('OnlyForUiTest123!', { exact: true }).waitFor();
      await activate(ready.getByRole('button', { name: 'Close dialog' }));
      await activate(staff.getByRole('button', { name: 'Delete', exact: true })); await staff.waitFor({ state: 'detached' });
      await activate(page.getByRole('button', { name: 'Generate account', exact: true }));
      const form = page.getByRole('dialog', { name: 'Generate staff account', exact: true });
      await form.getByRole('textbox', { name: 'Full name', exact: true }).fill('New Staff');
      await form.getByRole('textbox', { name: 'Username', exact: true }).fill('new_staff');
      await activate(form.getByRole('button', { name: 'Regenerate', exact: true }));
      await activate(form.getByRole('button', { name: 'Generate account', exact: true }));
      await ready.getByText('new_staff', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(writes.map(write => write.method), ['PATCH', 'PATCH', 'PATCH', 'PATCH', 'DELETE', 'POST']);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px Team: role, disable/enable, reset, delete, generate, touch targets, no horizontal overflow or browser errors.`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
