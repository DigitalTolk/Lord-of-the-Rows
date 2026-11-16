// Table open over a slow link (VPN). Skipped unless E2E_SLOW_MYSQL_URL points at a MySQL
// reached through a latency proxy (e.g. toxiproxy, 25 ms each way) with a schema of
// ~150 tables and an `orders` table of 200k rows. Measures how long a table takes to
// show rows while a query tab is open (its autocomplete used to describe every table
// one by one on the session's connection) and writes artifacts/open-latency.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, resultsText, sleep, until, waitText } from '../lib.mjs';

const URL = process.env.E2E_SLOW_MYSQL_URL;

test('table opens fast with a query tab open, over a slow link', { skip: !URL && 'set E2E_SLOW_MYSQL_URL' }, async () => {
  const b = await launch();
  try {
    await waitText(b, 'Create a new connection');
    await clickText(b, 'Connect from URL');
    await fill(b, 'Import from URL', URL);
    const c0 = Date.now();
    await clickText(b, 'OK', { exact: true });
    await until(async () => (await pageText(b)).includes('t_150'), 'object tree', 60000);
    const connectMs = Date.now() - c0;

    // A query tab: its autocomplete loads the schema's columns in the background.
    await clickSel(b, 'button[aria-label="New SQL query"]');
    await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');

    // Open the big table straight away and time until its rows show.
    const t0 = Date.now();
    await clickText(b, 'orders', { exact: true, selector: '[role=treeitem]' });
    await until(async () => /order-\d+/.test(await resultsText(b)), 'orders rows', 300000);
    const openMs = Date.now() - t0;
    const status = await b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [aria-live=polite]')?.innerText ?? '');
    await sleep(1000);

    const out = { connectMs, openOrdersWithQueryTabMs: openMs, status };
    fs.mkdirSync('./artifacts', { recursive: true });
    fs.writeFileSync('./artifacts/open-latency.json', JSON.stringify(out, null, 2));
    console.log('OPEN-LATENCY', JSON.stringify(out));
    assert.ok(openMs < 60000, `orders took ${openMs} ms`);
  } finally {
    await b.deleteSession();
  }
});
