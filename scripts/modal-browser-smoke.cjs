// Actual shared UI components, bundled in memory; no database or production writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const uiPath = path.resolve('components/ui.tsx').replaceAll('\\', '/');
  const { outputFiles } = await require('esbuild').build({
    stdin: { contents: `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Modal, Notice, useNotice, apiRequest } from ${JSON.stringify(uiPath)};
      function TestApp() {
        const [open, setOpen] = useState(false);
        const { notice, show } = useNotice();
        return <div style={{ transform: 'translateZ(0)', minHeight: 1600 }}>
          {notice && <Notice {...notice} />}
          <button className="button button-primary" onClick={() => setOpen(true)}>Open test form</button>
          <Modal open={open} title="Test member form" onClose={() => setOpen(false)}>
            <form className="modal-form" onSubmit={async event => { event.preventDefault(); try { await apiRequest('/api/test-save', { method: 'POST', body: '{}' }); } catch (error) { show(error.message, 'error'); } }}>
              <label className="field"><span>Name</span><input name="name" required /></label>
              <button className="button button-primary">Save test member</button>
            </form>
          </Modal>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<TestApp />);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = outputFiles[0].text;
  const css = await fs.readFile('app/globals.css', 'utf8');
  const { chromium } = require(path.join(process.argv[2], 'playwright'));
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const width of [390, 768, 1024, 1360]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 900 });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: js });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css', body: css });
        if (url.pathname === '/api/test-save') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Test save unavailable. Please retry.' }) });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
      });
      const activate = locator => width < 900 ? locator.tap() : locator.click();
      await page.goto('http://ui-qa.test/');
      const open = page.getByRole('button', { name: 'Open test form', exact: true });
      const dialog = page.getByRole('dialog', { name: 'Test member form', exact: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        await activate(open);
        await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Test Member');
        await activate(dialog.getByRole('button', { name: 'Save test member', exact: true }));
        await dialog.locator('.notice-error').waitFor();
        assert.equal(await dialog.evaluate(el => el.matches(':modal') && el.parentElement === document.body), true);
        const close = dialog.getByRole('button', { name: 'Close dialog' });
        assert.equal(await close.evaluate(el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el === hit || el.contains(hit); }), true);
        await page.keyboard.press('Tab');
        assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
        if (attempt === 0) await activate(close); else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px shared modal: error response visible in top layer, close/reopen/Escape, pointer hits, focus and scroll restoration; no browser errors.`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
