// Export dialog (MySQL): opened from a table's context menu with that table checked; the
// database checkbox selects all its tables; formats switch their options; the file-name
// preview follows the pattern. (The native save/folder dialogs aren't driven here; the export
// itself is covered by the Rust test against MySQL.)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickText, fill, launch, pageText, screenshot, sleep, until, waitText } from '../lib.mjs';

let b;
before(async () => {
  b = await launch();
  await waitText(b, 'Create a new connection');
});
after(async () => b?.deleteSession());

async function fail(name, fn) {
  try {
    await fn();
  } catch (e) {
    await screenshot(b, `FAIL-48-${name}`);
    throw e;
  }
}

const dialog = () => b.execute(() => document.querySelector('[role=dialog]')?.innerText ?? '');

describe('export dialog', () => {
  test('open from a table, pick tables and a format', () =>
    fail('dialog', async () => {
      await clickText(b, 'Connect from URL');
      await fill(b, 'Import from URL', 'mysql://dbs_test:dbs_test@mysql:3306/dbs_test?ssl-mode=DISABLED');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await pageText(b)).includes('customers'), 'object tree');

      await b.execute(() => {
        const item = [...document.querySelectorAll('[role=treeitem]')].find((x) => x.innerText.trim() === 'orders');
        const r = item.getBoundingClientRect();
        item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 }));
      });
      await clickText(b, 'Export…', { exact: true, selector: '[role=menuitem]' });
      await until(async () => (await dialog()).includes('Export from'), 'export dialog');
      assert.match(await dialog(), /1 selected/);
      assert.equal(await b.execute(() => document.querySelector('[role=dialog] [aria-label="File names"]')?.innerText), 'orders.csv');

      // Everything in the database, as one SQL script.
      await b.execute(() => document.querySelector('[role=dialog] input[aria-label="All tables in dbs_test"]')?.click());
      await until(async () => /[3-9]\d* selected/.test(await dialog()), 'all tables selected');
      await clickText(b, 'SQL', { exact: true, selector: '[role=dialog] [role=radio]' });
      await until(async () => (await dialog()).includes('CREATE TABLE (structure)'), 'SQL options');
      await fill(b, 'File name', '{database}_{date}');
      await until(async () => /dbs_test_\d{4}-\d\d-\d\d\.sql/.test(await dialog()), 'pattern preview');
      await screenshot(b, 'export-dialog');
      await sleep(200);
      await clickText(b, 'Cancel', { exact: true, selector: '[role=dialog] button' });
      await until(async () => !(await b.execute(() => !!document.querySelector('[role=dialog]'))), 'dialog closed');
    }));
});
