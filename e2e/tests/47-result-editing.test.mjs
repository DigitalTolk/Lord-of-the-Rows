// Editing a query result in place (MySQL): the result of a one-table SELECT with its primary key
// is editable, aliased columns write to their real column, expressions stay read-only, and the
// commit changes the table. Then Jump to (Mod+J) finds a column.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickText, fill, launch, pageText, resultsText, runSql, screenshot, sleep, until, waitText } from '../lib.mjs';

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
    await screenshot(b, `FAIL-47-${name}`);
    throw e;
  }
}

/** Dispatch a mouse event on the visible grid's cell in the row containing `rowText`, column `col`. */
async function cellEvent(type, rowText, col) {
  await until(
    () =>
      b.execute(
        (type, rowText, col) => {
          const panel = document.querySelector('[role=tabpanel]:not([hidden])') ?? document;
          const header = [...panel.querySelectorAll('[role=columnheader]')].map((h) => h.innerText.trim());
          const idx = header.indexOf(col);
          const row = [...panel.querySelectorAll('[role=row]')].find((r) => [...r.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === rowText));
          const cell = row?.querySelectorAll('[role=gridcell]')[idx];
          if (!cell) return false;
          const r = cell.getBoundingClientRect();
          cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
          return true;
        },
        type,
        rowText,
        col,
      ),
    `cell ${rowText}/${col}`,
  );
  await sleep(200);
}

const editorOpen = () => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) input[aria-label="Edit value"]'));

async function editCell(rowText, col, value) {
  await cellEvent('dblclick', rowText, col);
  await until(editorOpen, 'cell editor');
  await fill(b, 'Edit value', value);
  await b.execute(() => document.querySelector('input[aria-label="Edit value"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await sleep(200);
}

describe('query result editing', () => {
  test('edit an aliased column of a query result and commit it', () =>
    fail('edit', async () => {
      await clickText(b, 'Connect from URL');
      await fill(b, 'Import from URL', 'mysql://dbs_test:dbs_test@mysql:3306/dbs_test?ssl-mode=DISABLED');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await pageText(b)).includes('customers'), 'object tree');

      const before = await b.execute(() => [...document.querySelectorAll('[role=tabpanel]')].map((p) => p.id));
      await b.execute(() => document.querySelector('button[aria-label="New SQL query"]')?.click());
      await until(
        () =>
          b.execute((ids) => {
            const p = document.querySelector('[role=tabpanel]:not([hidden])');
            return !!(p && !ids.includes(p.id) && p.querySelector('.monaco-editor'));
          }, before),
        'new query tab',
      );
      await runSql(b, "CREATE TABLE IF NOT EXISTS e2e_edit (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO e2e_edit VALUES (1, 'alpha'), (2, 'beta') ON DUPLICATE KEY UPDATE name = VALUES(name)");
      await until(async () => /rows? affected/.test(await resultsText(b)), 'fixture ready', 20000);

      const query = 'SELECT id, name AS label, UPPER(name) AS shout FROM e2e_edit ORDER BY id';
      await runSql(b, query);
      await until(async () => (await resultsText(b)).includes('Editable · e2e_edit'), 'result is editable', 20000);

      // The expression column is read-only.
      await cellEvent('dblclick', 'ALPHA', 'shout');
      assert.equal(await editorOpen(), false, 'expression cells do not open an editor');

      await editCell('alpha', 'label', 'renamed');
      await until(async () => (await resultsText(b)).includes('1 pending change'), 'pending change');
      await b.execute(() => [...document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=group] button')].find((x) => x.innerText.trim() === 'Commit')?.click());
      await waitText(b, 'Committed 1 row');
      await until(async () => !(await resultsText(b)).includes('pending change'), 'pending cleared');

      // The table really changed: run the query again.
      await runSql(b, query);
      await until(async () => {
        const t = await resultsText(b);
        return t.includes('renamed') && !t.includes('alpha');
      }, 'committed value read back', 20000);

      // Jump to (Mod+J) a column by name.
      await b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [role=grid]')?.focus());
      await b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [role=grid]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true })));
      await until(() => b.execute(() => !!document.querySelector('[role=dialog][aria-label="Jump to"]')), 'jump palette');
      await fill(b, 'Jump to', 'shout');
      await b.execute(() => document.querySelector('[role=dialog][aria-label="Jump to"] input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await until(
        () => b.execute(() => [...document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=gridcell][aria-selected=true]')].map((c) => c.innerText.trim()).join() === 'RENAMED'),
        'jumped to the shout column',
      );
    }));
});
