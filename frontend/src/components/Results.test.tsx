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
