import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

const ipc = vi.hoisted(() => ({ killDbSession: vi.fn(), listDbSessions: vi.fn(async () => []) }));
vi.mock('../lib/ipc', () => ({ api: ipc, IpcError: class extends Error {} }));

import { useActivity } from '../lib/activityStore';
import type { ActivityRow, StopAssessment } from '../lib/types';
import { useApp, type OpenSession } from '../store';
import { ActivityList } from './Activity';

const stop = (o: Partial<StopAssessment> = {}): StopAssessment => ({ impact: 'nothing_to_undo', severity: 'safe', kill_discards_transaction: false, rows: null, can_cancel: true, can_kill: true, ...o });
const rows: ActivityRow[] = [
  { id: '10', user: 'app', client: '10.0.0.5', database: 'core', query: 'UPDATE orders SET status = 1', duration_ms: 250_000, in_transaction: true, trx_rows_modified: 120_000, stop: stop({ impact: 'undo_write', severity: 'caution', rows: 120_000, kill_discards_transaction: true }) },
  { id: '11', user: 'app', database: 'core', query: 'SELECT * FROM orders FOR UPDATE', duration_ms: 180_000, blocked_by: '10', stop: stop() },
  { id: '20', user: 'report', database: 'core', query: 'SELECT COUNT(*) FROM audit_log', duration_ms: 38_000, stop: stop() },
  { id: '30', user: 'app', database: 'core', command: 'Sleep', duration_ms: 5000, stop: stop({ impact: 'idle', can_cancel: false }) },
  { id: '5', user: 'event_scheduler', command: 'Daemon', system: true, duration_ms: 9_000_000, stop: stop({ impact: 'system', severity: 'blocked', can_cancel: false, can_kill: false }) },
];

function session(o: Partial<OpenSession['config']> = {}): OpenSession {
  return { session_id: 's1', config: { name: 'prod-core', environment: 'staging', read_only: false, engine: 'my_sql', ...o }, capabilities: { kill_session: true, sessions_monitor: true } } as unknown as OpenSession;
}

function setup(o: Partial<OpenSession['config']> = {}) {
  useActivity.setState({ frozen: false, bySession: { s1: { rows, at: 1, error: null, loading: false } } });
  return render(<ActivityList session={session(o)} />);
}
const rowOf = (id: string) => screen.getAllByRole('row').find((r) => r.textContent?.includes(`#${id}`))!;

describe('ActivityList', () => {
  afterEach(cleanup);
  beforeEach(() => {
    ipc.killDbSession.mockReset();
    useApp.setState({ toasts: [] });
  });

  it('shows the lock chain first, then running queries; idle connections are collapsed', () => {
    setup();
    const ids = screen.getAllByRole('row').map((r) => /#(\d+)/.exec(r.textContent ?? '')?.[1]);
    // Background server threads (always present) sit with the idle connections, not in Running.
    expect(ids).toEqual(['10', '11', '20']);
    expect(screen.getByText(/Blocking \(1\)/)).toBeTruthy();
    expect(screen.getByText('Rolls back 120,000 changed rows')).toBeTruthy();
    fireEvent.click(screen.getByText('+ 2 idle connections'));
    expect(rowOf('30')).toBeTruthy();
    expect(screen.getByText('Server thread')).toBeTruthy();
  });

  it('server threads cannot be stopped, and the buttons say why', () => {
    setup();
    fireEvent.click(screen.getByText('+ 2 idle connections'));
    fireEvent.click(rowOf('5'));
    const kill = screen.getByRole('button', { name: /Kill connection/ });
    expect(kill.hasAttribute('disabled')).toBe(true);
    expect(kill.getAttribute('title')).toMatch(/replication/);
  });

  it('a read-only connection shows the actions disabled with the reason', () => {
    setup({ read_only: true });
    fireEvent.click(rowOf('20'));
    const cancel = screen.getByRole('button', { name: /Cancel query/ });
    expect(cancel.hasAttribute('disabled')).toBe(true);
    expect(cancel.getAttribute('title')).toMatch(/Read-only/);
  });

  it('killing explains what is lost, then stops it through the confirmation token', async () => {
    ipc.killDbSession.mockResolvedValueOnce({ confirm: { token: 'tok', message: 'm' } }).mockResolvedValueOnce({ ok: true });
    setup();
    fireEvent.click(rowOf('10'));
    fireEvent.click(screen.getByRole('button', { name: /Kill connection/ }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/rolls this write back/)).toBeTruthy();
    expect(within(dlg).getByText(/discards the transaction’s 120,000 uncommitted changed rows/)).toBeTruthy();
    await act(async () => fireEvent.click(within(dlg).getByRole('button', { name: 'Kill connection' })));
    expect(ipc.killDbSession).toHaveBeenNthCalledWith(1, 's1', '10', 'connection');
    expect(ipc.killDbSession).toHaveBeenNthCalledWith(2, 's1', '10', 'connection', 'tok');
    expect(useApp.getState().toasts.at(-1)?.text).toBe('Killed 1 connection');
  });

  it('on production, killing needs the connection name typed', async () => {
    setup({ environment: 'production' });
    fireEvent.click(rowOf('20'));
    fireEvent.click(screen.getByRole('button', { name: /Kill connection/ }));
    const dlg = await screen.findByRole('dialog');
    const ok = within(dlg).getByRole('button', { name: 'Kill connection' });
    expect(ok.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/Type the connection name/), { target: { value: 'prod-core' } });
    expect(ok.hasAttribute('disabled')).toBe(false);
  });

  it('cancels the selected queries together; idle connections are left out', async () => {
    ipc.killDbSession.mockResolvedValue({ ok: true });
    setup();
    fireEvent.click(screen.getByText('+ 2 idle connections'));
    for (const id of ['20', '11', '30']) fireEvent.click(within(rowOf(id)).getByRole('checkbox'));
    expect(screen.getByText('3 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel 2 queries' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getAllByRole('listitem')).toHaveLength(2);
    await act(async () => fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel query' })));
    expect(ipc.killDbSession.mock.calls.map((c) => [c[1], c[2]])).toEqual([['20', 'query'], ['11', 'query']]);
  });

  it('holds live updates while you work with the list', () => {
    setup();
    expect(useActivity.getState().frozen).toBe(false);
    fireEvent.mouseEnter(screen.getByRole('grid'));
    expect(useActivity.getState().frozen).toBe(true);
    fireEvent.mouseLeave(screen.getByRole('grid'));
    expect(useActivity.getState().frozen).toBe(false);
    fireEvent.click(within(rowOf('20')).getByRole('checkbox'));
    expect(useActivity.getState().frozen).toBe(true);
  });
});
