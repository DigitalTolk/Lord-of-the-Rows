import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('../lib/ipc', () => ({ api: { useSchema: vi.fn(async () => {}), listObjects: vi.fn(async () => []) }, IpcError: class extends Error {} }));

import { useApp, type OpenSession } from '../store';
import { ConnectionRail, useOpenedSchemas } from './ConnectionRail';

afterEach(cleanup);

const session = {
  session_id: 's1',
  server: { engine: 'my_sql', version: '8.4.7' },
  capabilities: {},
  policy: {},
  config: { id: 'c1', name: 'Local MySQL', engine: 'my_sql', environment: 'local', tls: { mode: 'disabled' } },
  schemas: ['inventory', 'billing_archive', 'reporting'],
  objects: { inventory: [], billing_archive: [] },
  activeSchema: 'inventory',
  healthy: true,
} as unknown as OpenSession;

describe('ConnectionRail', () => {
  it('labels connections and lists opened databases with names; click switches', async () => {
    useOpenedSchemas.setState({ bySession: { s1: ['billing_archive'] } });
    useApp.setState({ sessions: { s1: session }, activeSession: 's1', tabs: [] });
    render(<ConnectionRail />);
    expect(screen.getByText('Local MySQL')).toBeTruthy();
    const list = screen.getByRole('listbox', { name: 'Databases' });
    const options = [...list.querySelectorAll('[role=option]')];
    expect(options.map((o) => o.textContent)).toEqual(['billing_archive', 'inventory']);
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTitle('reporting')).toBeNull();
    await act(async () => fireEvent.click(options[0]));
    expect(useApp.getState().sessions.s1.activeSchema).toBe('billing_archive');
  });

  it('tags each connection with its environment; production stands out', () => {
    const prod = { ...session, session_id: 's2', config: { ...session.config, id: 'c2', name: 'Orders', environment: 'production' } } as unknown as OpenSession;
    useOpenedSchemas.setState({ bySession: {} });
    useApp.setState({ sessions: { s1: session, s2: prod }, activeSession: 's1', tabs: [] });
    render(<ConnectionRail />);
    expect(screen.getByText('Local')).toBeTruthy();
    expect(screen.getByText('Prod')).toBeTruthy();
    const prodButton = screen.getByRole('button', { name: /^Orders, Production/ });
    expect(prodButton.className).toContain('ring-danger-solid');
    expect(screen.getByRole('button', { name: /^Local MySQL, Local/ }).className).not.toContain('ring-danger-solid');
  });
});


describe('ConnectionRail menus', () => {
  const second = { ...session, session_id: 's2', config: { ...session.config, id: 'c2', name: 'Orders' } } as unknown as OpenSession;
  const items = () => screen.getAllByRole('menuitem').map((m) => m.textContent);

  it('a connection offers new tab, open database, refresh, new window, edit and close', async () => {
    const openSessionInNewWindow = vi.fn(async () => {});
    const closeOtherSessions = vi.fn(async () => {});
    useOpenedSchemas.setState({ bySession: {} });
    useApp.setState({ sessions: { s1: session, s2: second }, activeSession: 's1', tabs: [], openSessionInNewWindow, closeOtherSessions } as never);
    render(<ConnectionRail />);
    fireEvent.contextMenu(screen.getByText('Local MySQL').closest('button')!);
    expect(items()).toEqual(['New query', 'Open database…', 'Refresh', 'Move to new window', 'Open in new window', 'Edit connection', 'Close connection', 'Close other connections']);
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Move to new window' })));
    expect(openSessionInNewWindow).toHaveBeenCalledWith('s1', true);
    fireEvent.contextMenu(screen.getByText('Local MySQL').closest('button')!);
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Close other connections' })));
    expect(closeOtherSessions).toHaveBeenCalledWith('s1');
  });

  it('"Close other connections" is disabled with a single connection', () => {
    useApp.setState({ sessions: { s1: session }, activeSession: 's1', tabs: [] });
    render(<ConnectionRail />);
    fireEvent.contextMenu(screen.getByText('Local MySQL').closest('button')!);
    expect(screen.getByRole('menuitem', { name: 'Close other connections' }).hasAttribute('disabled')).toBe(true);
  });

  it('an opened database can be opened, refreshed, copied, closed, or keep only itself', async () => {
    useOpenedSchemas.setState({ bySession: { s1: ['billing_archive', 'inventory', 'reporting'] } });
    useApp.setState({ sessions: { s1: session }, activeSession: 's1', tabs: [] });
    render(<ConnectionRail />);
    const list = screen.getByRole('listbox', { name: 'Databases' });
    const reporting = [...list.querySelectorAll('[role=option]')].find((o) => o.textContent === 'reporting')!;
    fireEvent.contextMenu(reporting);
    expect(items()).toEqual(['Open', 'New query', 'Refresh', 'Copy name', 'Close', 'Close other databases']);
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Close other databases' })));
    expect(useOpenedSchemas.getState().bySession.s1).toEqual(['reporting']);
  });
});
