import { describe, expect, it, vi } from 'vitest';
import { loadTablePage, type TablePageRequest } from './tablePage';
import type { ResultSet, TableDescription } from './types';

vi.mock('./ipc', () => ({ api: {} }));

const rs = (tag: string) => ({ columns: [], rows: [[tag]], truncated: false }) as unknown as ResultSet;
const desc = { primary_key: ['id'], columns: [], estimated_rows: 10 } as unknown as TableDescription;

function setup(over: Partial<TablePageRequest> = {}) {
  const calls: string[] = [];
  const api = {
    fetchTable: vi.fn(async (_s: string, _t: unknown, p: { order_by: unknown[] }) => {
      calls.push(`fetch:${JSON.stringify(p.order_by)}`);
      return rs(p.order_by.length ? 'ordered' : 'plain');
    }),
    describeTable: vi.fn(async () => {
      calls.push('describe');
      return desc;
    }),
  };
  const shown: string[] = [];
  const descs: unknown[] = [];
  let live = true;
  const req: TablePageRequest = { sessionId: 's', engine: 'postgres', target: { schema: 'shop', table: 't' }, desc: null, sort: [], filters: [], offset: 0, limit: 300, ...over };
  const run = () =>
    loadTablePage(req, { onRows: (r) => shown.push(String(r.rows[0][0])), onDesc: (d) => descs.push(d), current: () => live }, { api: api as never });
  return { api, calls, shown, descs, run, stop: () => (live = false) };
}

describe('loadTablePage', () => {
  it('shows rows before loading the description, then re-reads page 1 in key order', async () => {
    const t = setup();
    expect(await t.run()).toBe(desc);
    expect(t.calls).toEqual(['fetch:[]', 'describe', 'fetch:[["id","asc"]]']);
    expect(t.shown).toEqual(['plain', 'ordered']);
    expect(t.descs).toEqual([desc]);
  });

  it('skips the re-read where rows already come in key order (InnoDB)', async () => {
    for (const engine of ['my_sql', 'maria_db'] as const) {
      const t = setup({ engine });
      await t.run();
      expect(t.calls).toEqual(['fetch:[]', 'describe']);
    }
  });

  it('uses the known key order straight away and does not describe again', async () => {
    const t = setup({ desc });
    await t.run();
    expect(t.calls).toEqual(['fetch:[["id","asc"]]']);
    expect(t.descs).toEqual([]);
  });

  it('keeps a user sort and never re-orders it', async () => {
    const t = setup({ sort: [['name', 'desc']] });
    await t.run();
    expect(t.calls).toEqual(['fetch:[["name","desc"]]', 'describe']);
  });

  it('DynamoDB never orders', async () => {
    const t = setup({ engine: 'dynamo_db', sort: [['name', 'asc']] });
    await t.run();
    expect(t.calls).toEqual(['fetch:[]', 'describe']);
  });

  it('drops results of a load that was superseded', async () => {
    const t = setup();
    t.api.fetchTable.mockImplementationOnce(async () => {
      t.stop();
      return rs('stale');
    });
    await t.run();
    expect(t.shown).toEqual([]);
    expect(t.api.describeTable).not.toHaveBeenCalled();
  });

  it('a failed description still leaves the rows on screen', async () => {
    const t = setup();
    t.api.describeTable.mockRejectedValueOnce(new Error('no access to information_schema'));
    expect(await t.run()).toBeNull();
    expect(t.shown).toEqual(['plain']);
    expect(t.descs).toEqual([null]);
  });
});
