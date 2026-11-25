import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { OpenSession } from '../store';
import type { StatementResult } from '../lib/types';

const api = vi.hoisted(() => ({
  describeTable: vi.fn(async () => ({ primary_key: ['id'] })),
  previewChanges: vi.fn(async () => ({ statements: ['UPDATE `shop`.`orders` SET `total` = ? WHERE `id` = ?'], decision: { decision: 'allow' } })),
  applyChanges: vi.fn(async () => ({ committed: true, conflicts: [], applied: 1, rows_affected: 1 })),
  pickFile: vi.fn(async () => ({ grant: 'g1', name: 'x', display_path: '/tmp/x' })),
  exportRows: vi.fn(async () => ({ rows: 1, path: '/tmp/x.csv' })),
  exportQuery: vi.fn(async () => ({ rows: 50000, path: '/tmp/x.csv' })),
  splitSql: vi.fn(async () => [[0, 9], [10, 40]] as [number, number][]),
}));
vi.mock('../lib/ipc', () => ({ api, IpcError: class extends Error {} }));

import { useApp } from '../store';
import { Results } from './Results';

const session = (read_only = false) =>
  ({
    session_id: 's1',
    capabilities: { sql: true, inline_edit: true },
    config: { id: 'c1', name: 'shop', engine: 'mysql', environment: 'development', read_only },
    schemas: [],
    objects: {},
    activeSchema: null,
    healthy: true,
  }) as unknown as OpenSession;

const result = (cols: { name: string; table?: string; column?: string }[]): StatementResult[] => [
  {
    statement_index: 0,
    sql_excerpt: 'SELECT …',
    duration_ms: 3,
    notices: [],
    result: {
      columns: cols.map((c) => ({ name: c.name, type_name: 'INT', table: c.table, column: c.column, schema: c.table ? 'shop' : null })),
      rows: [[{ t: 'int', v: 10 }, { t: 'int', v: 5 }]],
      truncated: false,
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, toJSON: () => ({}) } as DOMRect);
  useApp.setState({ sessions: { s1: session() } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useApp.setState({ sessions: {} });
});

const cell = (text: string) => screen.getAllByRole('gridcell').find((c) => c.textContent === text)!;

describe('editing a query result', () => {
  it('stages an edit, commits it against the source table and updates the row', async () => {
    const results = result([{ name: 'id', table: 'orders', column: 'id' }, { name: 'amount', table: 'orders', column: 'total' }]);
    render(<Results results={results} messages={[]} runId="r1" sessionId="s1" />);
    await screen.findByText('Editable · orders');
    expect(api.describeTable).toHaveBeenCalledWith('s1', { schema: 'shop', table: 'orders' });
    fireEvent.doubleClick(cell('5'));
    const input = screen.getByRole('textbox', { name: 'Edit value' });
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('1 pending change(s)')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Commit' })[0]);
    });
    expect(api.applyChanges).toHaveBeenCalledWith(
      's1',
      { schema: 'shop', table: 'orders' },
      [{ op: 'update', key: [['id', { t: 'int', v: 10 }]], original: [['total', { t: 'int', v: 5 }]], changes: [['total', { t: 'int', v: 9 }]] }],
      null,
    );
    await waitFor(() => expect(screen.queryByText('1 pending change(s)')).toBeNull());
    expect(cell('9')).toBeTruthy();
  });

  it('stays read-only without the primary key, for joins and on read-only connections', async () => {
    const { rerender } = render(<Results results={result([{ name: 'amount', table: 'orders', column: 'total' }, { name: 'x' }])} messages={[]} runId="a" sessionId="s1" />);
    await screen.findByText('Read-only');
    fireEvent.doubleClick(cell('5'));
    expect(screen.queryByRole('textbox', { name: 'Edit value' })).toBeNull();

    rerender(<Results results={result([{ name: 'id', table: 'orders', column: 'id' }, { name: 'name', table: 'customers', column: 'name' }])} messages={[]} runId="b" sessionId="s1" />);
    expect(screen.getByText('Read-only').closest('[title]')?.getAttribute('title')).toMatch(/more than one table/);

    useApp.setState({ sessions: { s1: session(true) } });
    rerender(<Results results={result([{ name: 'id', table: 'orders', column: 'id' }, { name: 'amount', table: 'orders', column: 'total' }])} messages={[]} runId="c" sessionId="s1" />);
    expect(screen.queryByText(/Editable/)).toBeNull();
  });
});

describe('several statements', () => {
  it('shows a tab per result set, the last one first, plus Messages', () => {
    const rs = (stmt: number, col: string, v: number): StatementResult => ({
      statement_index: stmt,
      sql_excerpt: `SELECT ${v} AS ${col}`,
      duration_ms: 1,
      notices: [],
      result: { columns: [{ name: col, type_name: 'INT' }], rows: [[{ t: 'int', v }]], truncated: false },
    });
    const results: StatementResult[] = [rs(0, 'a', 1), { statement_index: 1, sql_excerpt: 'UPDATE t SET x = 1', duration_ms: 1, notices: [], rows_affected: 3 }, rs(2, 'b', 2)];
    render(<Results results={results} messages={[]} runId="m" />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    // No table in the column metadata or the SQL: numbered tabs, each with its row count.
    expect(tabs).toEqual(['Result 11 row', 'Result 21 row', 'Messages3']);
    expect(screen.getByRole('tab', { name: /Result 2/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Result 2/ }).getAttribute('title')).toBe('Statement 3: SELECT 2 AS b');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['b']);
    fireEvent.click(screen.getByRole('tab', { name: /Result 1/ }));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['a']);
  });

  it('a single result keeps the plain "Results" tab', () => {
    const one: StatementResult[] = [{ statement_index: 0, sql_excerpt: 'SELECT 1', duration_ms: 1, notices: [], result: { columns: [{ name: 'n', type_name: 'INT' }], rows: [[{ t: 'int', v: 1 }]], truncated: false } }];
    render(<Results results={one} messages={[]} runId="s" />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Results', 'Messages1']);
  });
});

describe('row detail panel', () => {
  it('shows the selected row as fields; edits stage like the grid; expressions stay read-only', async () => {
    const results = result([{ name: 'id', table: 'orders', column: 'id' }, { name: 'amount', table: 'orders', column: 'total' }]);
    results[0].result!.columns.push({ name: 'plus', type_name: 'INT' });
    results[0].result!.rows[0].push({ t: 'int', v: 6 });
    render(<Results results={results} messages={[]} runId="d" sessionId="s1" />);
    await screen.findByText('Editable · orders');
    fireEvent.click(screen.getByRole('button', { name: 'Row details' }));
    fireEvent.mouseDown(cell('5'), { button: 0 });
    const panel = screen.getByRole('complementary', { name: 'Row details' });
    const amount = within(panel).getByLabelText(/^amount/) as HTMLInputElement;
    expect(amount.value).toBe('5');
    expect((within(panel).getByLabelText(/^plus/) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(amount, { target: { value: '8' } });
    fireEvent.blur(amount);
    expect(screen.getByText('1 pending change(s)')).toBeTruthy();
  });
});

describe('result tab names', () => {
  it('names tabs after their table and says when a result is empty', () => {
    const mk = (stmt: number, sql: string, table: string | null, rows: number): StatementResult => ({
      statement_index: stmt,
      sql_excerpt: sql,
      duration_ms: 1,
      notices: [],
      result: { columns: [{ name: 'id', type_name: 'INT', table, column: table ? 'id' : null, schema: table ? 'shop' : null }], rows: Array.from({ length: rows }, (_, i) => [{ t: 'int', v: i }]), truncated: false },
    });
    render(<Results results={[mk(0, 'SELECT id FROM orders', 'orders', 12), mk(1, 'SELECT COUNT(*) AS id FROM `shop`.`customers` c', null, 0)]} messages={[]} runId="n" />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['1 · orders12 rows', '2 · customers0 rows', 'Messages2']);
    expect(screen.getByText('No rows')).toBeTruthy();
  });
});

describe('export to a file', () => {
  const one = (truncated: boolean): StatementResult[] => [
    { statement_index: 0, sql_excerpt: 'SELECT 1', duration_ms: 1, notices: [], rows_affected: null },
    { statement_index: 1, sql_excerpt: 'SELECT * FROM feedbacks', duration_ms: 1, notices: [], result: { columns: [{ name: 'id', type_name: 'INT' }], rows: [[{ t: 'int', v: 1 }]], truncated } },
  ];
  const sql = 'SELECT 1; SELECT * FROM feedbacks LIMIT 10;';

  it('a complete result writes the rows it has (nothing runs again)', async () => {
    render(<Results results={one(false)} messages={[]} runId="e1" sessionId="s1" sql={sql} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'CSV…' }));
    });
    expect(api.pickFile).toHaveBeenCalledWith(true, 'feedbacks.csv', ['csv']);
    expect(api.exportRows).toHaveBeenCalledWith('s1', { table: 'feedbacks' }, expect.any(Array), [[{ t: 'int', v: 1 }]], 'g1', expect.objectContaining({ format: 'csv' }));
    expect(api.exportQuery).not.toHaveBeenCalled();
  });

  it('a cut-off result runs its own statement again and writes every row', async () => {
    render(<Results results={one(true)} messages={[]} runId="e2" sessionId="s1" sql={sql} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    expect(screen.getByText(/query runs again/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Excel (XLSX)…' }));
    });
    expect(api.splitSql).toHaveBeenCalledWith('mysql', sql);
    expect(api.exportQuery).toHaveBeenCalledWith('s1', sql.slice(10, 40), 'g1', expect.objectContaining({ format: 'xlsx' }), false);
    expect(api.exportRows).not.toHaveBeenCalled();
  });
});

