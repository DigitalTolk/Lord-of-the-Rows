import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_DESCRIBE_LIMIT, schemaColumns } from './schemaColumns';
import type { ObjectRef } from './types';

vi.mock('./ipc', () => ({ api: {} }));

const table = (name: string): ObjectRef => ({ kind: 'table', schema: 'shop', name }) as ObjectRef;
const fakeApi = (over: Record<string, unknown>) => ({ api: { listColumns: vi.fn(), describeTable: vi.fn(), ...over } as never });

describe('schemaColumns', () => {
  it('loads the whole schema in one call, shared by every tab', async () => {
    const listColumns = vi.fn(async () => [
      { table: 'customers', name: 'id', data_type: 'int' },
      { table: 'customers', name: 'email', data_type: 'text' },
      { table: 'orders', name: 'id', data_type: 'int' },
    ]);
    const deps = fakeApi({ listColumns });
    const objs = [table('customers'), table('orders')];
    const [a, b] = await Promise.all([schemaColumns('s1', 'shop', objs, deps), schemaColumns('s1', 'shop', objs, deps)]);
    expect(a).toEqual({ customers: ['id', 'email'], orders: ['id'] });
    expect(b).toBe(a);
    expect(listColumns).toHaveBeenCalledTimes(1);
    expect(listColumns).toHaveBeenCalledWith('s1', 'shop');
    expect((deps.api as { describeTable: ReturnType<typeof vi.fn> }).describeTable).not.toHaveBeenCalled();
  });

  it('loads again after a refresh (a new object list)', async () => {
    const listColumns = vi.fn(async () => []);
    const deps = fakeApi({ listColumns });
    await schemaColumns('s1', 'shop', [table('a')], deps);
    await schemaColumns('s1', 'shop', [table('a')], deps);
    expect(listColumns).toHaveBeenCalledTimes(2);
  });

  it('falls back to describing a bounded number of tables when unsupported', async () => {
    const describeTable = vi.fn(async (_s: string, t: { table: string }) => {
      if (t.table === 't1') throw new Error('gone');
      return { columns: [{ name: `${t.table}_id` }] };
    });
    const deps = fakeApi({ listColumns: vi.fn(async () => Promise.reject(new Error('unsupported'))), describeTable });
    const objs = Array.from({ length: FALLBACK_DESCRIBE_LIMIT + 10 }, (_, i) => table(`t${i}`));
    const cols = await schemaColumns('s1', null, objs, deps);
    expect(describeTable).toHaveBeenCalledTimes(FALLBACK_DESCRIBE_LIMIT);
    expect(cols.t0).toEqual(['t0_id']);
    expect(cols.t1).toBeUndefined();
  });
});
