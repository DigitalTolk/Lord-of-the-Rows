import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { OpenSession } from '../store';
import type { ExportProgress } from '../lib/types';

const api = vi.hoisted(() => ({
  pickFile: vi.fn(async () => ({ grant: 'file-grant', name: 'x', display_path: '/out/x' })),
  pickFolder: vi.fn(async () => ({ grant: 'dir-grant', name: 'out', display_path: '/out' })),
  exportTables: vi.fn(async (_req: unknown, on: (p: ExportProgress) => void) => {
    on({ kind: 'rows', index: 0, rows: 5000 });
    on({ kind: 'table_done', index: 0, rows: 7000, path: '/out/orders.csv' });
    on({ kind: 'table_done', index: 1, rows: 3, path: '/out/customers.csv' });
    return { tables: 2, rows: 7003, paths: ['/out/orders.csv', '/out/customers.csv'] };
  }),
  cancelQuery: vi.fn(async () => true),
  setSettings: vi.fn(async () => undefined),
}));
vi.mock('../lib/ipc', () => ({ api, IpcError: class extends Error {} }));

import { useApp } from '../store';
import { ExportDialog } from './ExportDialog';

const session = {
  session_id: 's1',
  config: { name: 'shop-db', engine: 'mysql' },
  capabilities: {},
  schemas: ['shop', 'audit'],
  activeSchema: 'shop',
  objects: { shop: [{ kind: 'table', schema: 'shop', name: 'orders' }, { kind: 'table', schema: 'shop', name: 'customers' }, { kind: 'function', schema: 'shop', name: 'f' }] },
} as unknown as OpenSession;

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ sessions: { s1: session }, settings: {}, setSetting: vi.fn(async () => undefined), loadObjects: vi.fn(async () => undefined) } as never);
});
afterEach(cleanup);

describe('ExportDialog', () => {
  it('exports the chosen tables, one CSV per table into a folder, with progress', async () => {
    const onClose = vi.fn();
    render(<ExportDialog s={session} req={{ sessionId: 's1', tables: [{ schema: 'shop', table: 'orders' }] }} onClose={onClose} />);
    expect(screen.queryByText('f')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /customers/ }));
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Delimiter' }), { target: { value: ';' } });
    expect(screen.getByLabelText('File names').textContent).toBe('orders.csv, customers.csv');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export to folder…' }));
    });
    expect(api.pickFolder).toHaveBeenCalled();
    const req = api.exportTables.mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({ session_id: 's1', grant: 'dir-grant', one_file: false, file_names: ['orders.csv', 'customers.csv'], options: { format: 'csv', delimiter: ';' } });
    expect(screen.getAllByText('Exported 7,003 rows from 2 tables').length).toBeGreaterThan(0);
    expect(screen.getByText('7,000 rows')).toBeTruthy();
  });

  it('SQL goes into one file with structure and data; all tables of a database at once', async () => {
    render(<ExportDialog s={session} req={{ sessionId: 's1', tables: [] }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'SQL' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'All tables in shop' }));
    });
    expect(screen.getByText('2 selected')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    });
    expect(api.pickFile).toHaveBeenCalledWith(true, 'orders.sql', ['sql']);
    expect(api.exportTables.mock.calls[0][0]).toMatchObject({ one_file: true, grant: 'file-grant', options: { format: 'sql_insert' }, sql: { structure: true, data: true, drop: false } });
  });

  it('from a filtered table tab, offers only the matching rows', async () => {
    const filters = [{ column: 'status', op: 'eq', value: { t: 'text', v: 'paid' } }];
    render(<ExportDialog s={session} req={{ sessionId: 's1', tables: [{ schema: 'shop', table: 'orders' }], filters: filters as never }} onClose={() => {}} />);
    const only = screen.getByRole('checkbox', { name: /current filter/ }) as HTMLInputElement;
    expect(only.checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    });
    expect(api.exportTables.mock.calls[0][0]).toMatchObject({ one_file: true, filters });
  });
});
