import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { OpenSession } from '../store';
import type { StatementResult } from '../lib/types';

const api = vi.hoisted(() => ({
  describeTable: vi.fn(async () => ({ primary_key: ['id'] })),
  previewChanges: vi.fn(async () => ({ statements: ['UPDATE `shop`.`orders` SET `total` = ? WHERE `id` = ?'], decision: { decision: 'allow' } })),
  applyChanges: vi.fn(async () => ({ committed: true, conflicts: [], applied: 1, rows_affected: 1 })),
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
    expect(tabs).toEqual(['Result 11', 'Result 21', 'Messages (3)']);
    expect(screen.getByRole('tab', { name: /Result 2/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Result 2/ }).getAttribute('title')).toBe('Statement 3: SELECT 2 AS b');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['b']);
    fireEvent.click(screen.getByRole('tab', { name: /Result 1/ }));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['a']);
  });

  it('a single result keeps the plain "Results" tab', () => {
    const one: StatementResult[] = [{ statement_index: 0, sql_excerpt: 'SELECT 1', duration_ms: 1, notices: [], result: { columns: [{ name: 'n', type_name: 'INT' }], rows: [[{ t: 'int', v: 1 }]], truncated: false } }];
    render(<Results results={one} messages={[]} runId="s" />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Results', 'Messages (1)']);
  });
});

