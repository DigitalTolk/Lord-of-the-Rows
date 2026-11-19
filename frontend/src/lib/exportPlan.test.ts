import { describe, expect, it } from 'vitest';
import { buildRequest, DEFAULT_SETTINGS, extensionOf, fileName, fileNames, loadSettings, writesOneFile } from './exportPlan';

const now = new Date(2026, 10, 19, 9, 5, 7);
const t = (table: string, schema: string | null = 'shop') => ({ schema, table });

describe('export plan', () => {
  it('fills the file name pattern and keeps names safe', () => {
    expect(fileName('{database}_{table}_{date}', t('orders'), 'shop', now, 'csv')).toBe('shop_orders_2026-11-19.csv');
    expect(fileName('{table}-{time}', t('a/b:c'), 'shop', now, 'sql')).toBe('a_b_c-090507.sql');
    expect(fileName('../{table}', t('x'), 'db', now, 'csv')).toBe('_x.csv');
    expect(fileName('', t('x'), 'db', now, 'json')).toBe('x.json');
  });

  it('gives each table its own name, numbering repeats', () => {
    const s = { ...DEFAULT_SETTINGS, pattern: '{table}' };
    expect(fileNames(s, [t('a', 'x'), t('a', 'y'), t('b')], 'db', now)).toEqual(['a.csv', 'a (2).csv', 'b.csv']);
  });

  it('chooses one file only when the format can hold several tables', () => {
    expect(writesOneFile({ ...DEFAULT_SETTINGS, kind: 'csv', oneFile: true }, 3)).toBe(false);
    expect(writesOneFile({ ...DEFAULT_SETTINGS, kind: 'csv' }, 1)).toBe(true);
    expect(writesOneFile({ ...DEFAULT_SETTINGS, kind: 'sql', oneFile: true }, 3)).toBe(true);
    expect(writesOneFile({ ...DEFAULT_SETTINGS, kind: 'xlsx', oneFile: false }, 3)).toBe(false);
  });

  it('extensions follow the format and gzip', () => {
    expect(extensionOf({ ...DEFAULT_SETTINGS, delimiter: '\t' })).toBe('tsv');
    expect(extensionOf({ ...DEFAULT_SETTINGS, kind: 'json', jsonLines: true, gzip: true })).toBe('jsonl.gz');
    expect(extensionOf({ ...DEFAULT_SETTINGS, kind: 'xlsx', gzip: true })).toBe('xlsx');
  });

  it('builds the backend request', () => {
    const s = { ...DEFAULT_SETTINGS, delimiter: ';' as const, crlf: true, nullText: 'NULL' };
    const r = buildRequest(s, { exportId: 'e', sessionId: 's', tables: [t('a'), t('b')], grant: 'g', database: 'shop', now, filters: [{ x: 1 }] });
    expect(r).toMatchObject({ one_file: false, file_names: ['a.csv', 'b.csv'], filters: [], options: { format: 'csv', delimiter: ';', line_break: '\r\n', null_text: 'NULL' } });
    const one = buildRequest(s, { exportId: 'e', sessionId: 's', tables: [t('a')], grant: 'g', database: 'shop', now, filters: [{ x: 1 }] });
    expect(one).toMatchObject({ one_file: true, file_names: [], filters: [{ x: 1 }] });
    expect(buildRequest({ ...DEFAULT_SETTINGS, delimiter: '\t' }, { exportId: 'e', sessionId: 's', tables: [t('a')], grant: 'g', database: 'd', now }).options).toMatchObject({ format: 'tsv', delimiter: null });
  });

  it('loads saved settings over the defaults, ignoring junk', () => {
    expect(loadSettings({ kind: 'sql', rowsPerInsert: 'lots', nope: 1 })).toEqual({ ...DEFAULT_SETTINGS, kind: 'sql' });
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});
