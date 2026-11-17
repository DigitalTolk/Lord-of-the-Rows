// Activity (Mod+Shift+A): a long query in a query tab shows up as "You", and cancelling it
// from Activity (actions inside the expanded row, no scrolling) stops the query in the tab.
// The app's own session is busy running that query: Activity works over its side connection.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickText, fill, launch, pageText, resultsText, screenshot, sleep, until, waitText } from '../lib.mjs';

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
    await screenshot(b, `FAIL-36-${name}`);
    throw e;
  }
}

const panel = () => b.execute(() => document.querySelector('aside[aria-label="Activity"]')?.innerText ?? '');

describe('activity', () => {
  test('cancel your own running query from Activity', () =>
    fail('cancel', async () => {
      await clickText(b, 'Connect from URL');
      // root sees every thread (PROCESS privilege).
      await fill(b, 'Import from URL', 'mysql://root:dbs_root_test@mysql:3306/dbs_test?ssl-mode=DISABLED');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await pageText(b)).includes('customers'), 'object tree');

      await b.execute(() => document.querySelector('button[aria-label="New SQL query"]')?.click());
      await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
      await until(
        () =>
          b.execute(() => {
            const node = document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor');
            const ed = node && globalThis.__monaco?.editor.getEditors().find((e) => e.getContainerDomNode().contains(node) || node.contains(e.getContainerDomNode()));
            if (!ed) return false;
            ed.setValue('SELECT SLEEP(60) AS slept');
            return true;
          }),
        'set sql',
      );
      const t0 = Date.now();
      await clickText(b, 'Run all', { exact: true });
      await sleep(1500);

      await b.keys(['Control', 'Shift', 'a']);
      await until(async () => (await panel()).includes('SLEEP(60)'), 'query listed in Activity', 20000);
      assert.match(await panel(), /You/);

      // Expand the row: the actions are right below the query.
      await b.execute(() => {
        const row = [...document.querySelectorAll('aside[aria-label="Activity"] [role=row]')].find((r) => r.innerText.includes('SLEEP(60)'));
        row?.click();
      });
      await clickText(b, 'Cancel query', { exact: true, selector: 'aside[aria-label="Activity"] button' });
      await until(() => b.execute(() => !!document.querySelector('[role=dialog]')), 'confirmation');
      await clickText(b, 'Cancel query', { exact: true, selector: '[role=dialog] button' });
      await waitText(b, 'Cancelled 1 query');

      // The query tab stops long before SLEEP(60) would end.
      await until(async () => /slept|interrupt/i.test(await resultsText(b)), 'query stopped', 20000);
      assert.ok(Date.now() - t0 < 30000, `stopped after ${Date.now() - t0} ms`);
    }));
});
