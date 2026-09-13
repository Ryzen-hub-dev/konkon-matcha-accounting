const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function uiInteractions({ page: staffPage, base, output }) {
  for (const [width, height] of [[390, 844], [768, 1024], [1024, 768], [1360, 1000]]) {
    console.log(`Checking ${width}px touch/pointer interactions and form errors.`);
    const context = await staffPage.context().browser().newContext({ viewport: { width, height }, hasTouch: width < 900, isMobile: width < 700 });
    await context.addCookies(await staffPage.context().cookies());
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const activate = locator => width < 900 ? locator.tap() : locator.click();
    try {
    await page.goto(base + '/members');
    if (width <= 900) {
      await activate(page.getByRole('button', { name: 'Open navigation', exact: true }));
      await activate(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Point of sale', exact: true }));
      await page.waitForURL('**/pos');
      assert.equal(await page.locator('.mobile-scrim').count(), 0);
      await page.goto(base + '/members');
    }
    await activate(page.getByRole('button', { name: 'Add member', exact: true }).first());
    const add = page.getByRole('dialog', { name: 'Add a member', exact: true });
    await add.getByRole('textbox', { name: 'Full name', exact: true }).fill('UI interaction test');
    await add.getByRole('textbox', { name: 'Phone', exact: true }).fill('+60100000000');
    const rejectSave = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Test save unavailable. Please retry.' }) })
      : route.continue();
    await page.route('**/api/members', rejectSave);
    await activate(add.getByRole('button', { name: 'Add & issue card', exact: true }));
    await add.locator('.notice-error').filter({ hasText: 'Test save unavailable. Please retry.' }).waitFor();
    assert.equal(await add.locator('.notice-error').evaluate(notice => notice.closest('dialog')?.matches(':modal')), true, 'Form errors stay above the modal');
    await page.unroute('**/api/members', rejectSave);
    if (width === 390) await page.screenshot({ path: path.join(output, 'member-dialog-error-mobile.png') });
    const close = add.getByRole('button', { name: 'Close dialog', exact: true });
    assert.equal(await close.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return button === hit || button.contains(hit);
    }), true, `${width}px dialog close receives pointer events`);
    assert.equal(await add.evaluate(dialog => dialog.matches(':modal') && dialog.parentElement === document.body), true);
    await page.keyboard.press('Tab');
    assert.equal(await add.evaluate(dialog => dialog.contains(document.activeElement)), true);
    await activate(close);
    await add.waitFor({ state: 'detached' });
    await activate(page.getByRole('button', { name: 'Add member', exact: true }).first());
    await page.keyboard.press('Escape');
    await add.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
    await page.goto(base + '/inventory');
    await activate(page.getByRole('button', { name: 'New product', exact: true }).first());
    const product = page.getByRole('dialog', { name: 'New product', exact: true });
    await activate(product.getByRole('button', { name: 'Cancel', exact: true }));
    await product.waitFor({ state: 'detached' });
    await page.goto(base + '/pos');
    // Fixed-position controls must still work after the page has been scrolled.
    await page.locator('.app-footer').scrollIntoViewIfNeeded();
    await activate(page.getByRole('button', { name: 'Receipt templates', exact: true }));
    const studio = page.getByRole('dialog', { name: 'Receipt template studio', exact: true });
    await activate(studio.getByRole('button', { name: 'Close dialog', exact: true }));
    await studio.waitFor({ state: 'detached' });
    await activate(page.locator('.scanner-connect'));
    const scanner = page.getByRole('dialog', { name: 'Link an online scanner', exact: true });
    await scanner.getByRole('textbox', { name: 'Device label', exact: true }).fill('QA phone');
    await page.screenshot({ path: path.join(output, `clickable-dialog-${width}.png`) });
    await activate(scanner.getByRole('button', { name: 'Close dialog', exact: true }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
    assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: path.join(output, `interaction-failure-${width}.png`) }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  console.log('PASS real pointer clicks, navigation, visible form errors, modal fields/close/Escape/focus, scrolled-page dialogs at 390/768/1024/1360px.');
};
