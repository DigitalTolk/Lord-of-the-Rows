import { describe, expect, it } from 'vitest';
import { emptyStaged, setCell, toggleDelete } from './changes';
import { applyStaged, hasKey, resultSource, sourceChanges, type ResultSource } from './resultEdit';
import type { ColumnMeta, Value } from './types';

const col = (name: string, table?: string, column?: string, schema = 'shop'): ColumnMeta => ({ name, type_name: 'int', table, column, schema: table ? schema : null });

describe('resultSource', () => {
  it('maps aliased columns to their real names and leaves expressions read-only', () => {
    const src = resultSource([col('id', 'orders', 'id'), col('cust', 'orders', 'customer_id'), col('plus')]) as ResultSource;
    expect(src.target).toEqual({ schema: 'shop', table: 'orders' });
    expect(src.sourceOf).toEqual({ id: 'id', cust: 'customer_id' });
    expect(src.readOnly).toEqual(['plus']);
  });

  it('refuses results from several tables or from none', () => {
    expect(resultSource([col('id', 'orders', 'id'), col('name', 'customers', 'name')])).toBe('manyTables');
    expect(resultSource([col('id', 'orders', 'id', 'a'), col('x', 'orders', 'x', 'b')])).toBe('manyTables');
    expect(resultSource([col('n')])).toBe('noTable');
  });

  it('makes repeated result names read-only', () => {
    const src = resultSource([col('id', 'orders', 'id'), col('id', 'orders', 'customer_id')]) as ResultSource;
    expect(src.sourceOf).toEqual({});
    expect(src.readOnly).toEqual(['id', 'id']);
  });
});

describe('hasKey', () => {
  const src = resultSource([col('oid', 'orders', 'id'), col('total', 'orders', 'total')]) as ResultSource;
  it('needs every primary-key column, under any alias', () => {
    expect(hasKey(src, ['id'])).toBe(true);
    expect(hasKey(src, ['id', 'line'])).toBe(false);
    expect(hasKey(src, [])).toBe(false);
  });
});

describe('sourceChanges / applyStaged', () => {
  const columns = [col('oid', 'orders', 'id'), col('amount', 'orders', 'total'), col('plus')];
  const rows: Value[][] = [
    [{ t: 'int', v: 10 }, { t: 'int', v: 5 }, { t: 'int', v: 6 }],
    [{ t: 'int', v: 11 }, { t: 'int', v: 7 }, { t: 'int', v: 8 }],
  ];
  const src = resultSource(columns) as ResultSource;

  it('turns edits and deletes into changes on the source table by its key', () => {
    let s = setCell(emptyStaged(), 0, 'amount', { t: 'int', v: 9 }, rows[0][1]);
    s = toggleDelete(s, [1]);
    expect(sourceChanges(s, columns, rows, src, ['id'])).toEqual([
      { op: 'delete', key: [['id', { t: 'int', v: 11 }]], original: [] },
      { op: 'update', key: [['id', { t: 'int', v: 10 }]], original: [['total', { t: 'int', v: 5 }]], changes: [['total', { t: 'int', v: 9 }]] },
    ]);
  });

  it('updates the result rows in place after a commit', () => {
    let s = setCell(emptyStaged(), 0, 'amount', { t: 'int', v: 9 }, rows[0][1]);
    s = toggleDelete(s, [1]);
    expect(applyStaged(rows, columns, s)).toEqual([[{ t: 'int', v: 10 }, { t: 'int', v: 9 }, { t: 'int', v: 6 }]]);
  });
});
