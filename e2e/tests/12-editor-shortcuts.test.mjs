// Editor shortcuts belong to their own editor. Monaco's addCommand registered
// Ctrl+Enter globally and never removed it, so once a newer query editor was
// closed (tab closed, or another database's tab gone), Ctrl+Enter in a still-open
// editor ran the dead editor's handler and threw ("Unhandled: … getValue" on a
// null model). Here: query tab on Postgres, query tab on SQLite, close the SQLite
// tab, then Ctrl+Enter in the Postgres editor must run its query.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, resultsText, screenshot, sleep, until, waitText } from '../lib.mjs';

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
    await screenshot(b, `FAIL-12-${name}`);
    throw e;
  }
}

async function connectUrl(url) {
  await clickText(b, 'Connect from URL');
  await fill(b, 'Import from URL', url);
  await clickText(b, 'OK', { exact: true });
}

async function newQueryTab() {
  await clickSel(b, 'button[aria-label="New SQL query"]');
  await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
  await sleep(500);
}

/** Put `sql` in the visible editor and focus it (no Run click: the shortcut is what's tested). */
async function setVisibleEditor(sql) {
  await until(
    () =>
      b.execute((sql) => {
        const node = document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor');
        const ed = node && globalThis.__monaco?.editor.getEditors().find((e) => e.getContainerDomNode().contains(node) || node.contains(e.getContainerDomNode()));
        if (!ed) return false;
        ed.setValue(sql);
        ed.setPosition({ lineNumber: 1, column: 1 });
        ed.focus();
        return true;
      }, sql),
    'visible monaco editor',
  );
}

const unhandled = () => b.execute(() => [...document.querySelectorAll('pre[role=alert]')].map((e) => e.innerText).join('\n'));

describe('editor shortcuts', () => {
  test('Ctrl+Enter runs in the open editor after another query editor closed', () =>
    fail('ctrl-enter', async () => {
      await connectUrl('postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable');
      await until(async () => (await pageText(b)).includes('customers'), 'postgres object tree');
      await newQueryTab();

      // A second database with its own query editor (registered after the first).
      await clickSel(b, 'button[aria-label="Open another connection"]');
      await waitText(b, 'Create a new connection');
      await connectUrl(`sqlite://${process.env.E2E_SQLITE}`);
      await until(async () => (await pageText(b)).includes('customer_totals'), 'sqlite object tree');
      await newQueryTab();
      // Close it: its editor is disposed.
      await b.execute(() => document.querySelector('[role=tab][aria-selected=true] span[title]')?.click());
      await sleep(500);

      // Back on the Postgres query tab.
      // Switch back to the Postgres session (first in the connection rail).
      await b.execute(() => document.querySelector('nav button[aria-label]')?.click());
      await until(
        () => b.execute(() => [...document.querySelectorAll('[role=tab]')].some((t) => /query/i.test(t.innerText))),
        'postgres query tab listed',
      );
      await b.execute(() => [...document.querySelectorAll('[role=tab]')].find((t) => /query/i.test(t.innerText))?.click());
      await setVisibleEditor("select 'shortcut-ok' as marker");
      await b.keys(['Control', 'Enter']);
      await until(async () => (await resultsText(b)).includes('shortcut-ok'), 'query ran via Ctrl+Enter');
      assert.equal(await unhandled(), '', 'no unhandled error');
    }));
});
