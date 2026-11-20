import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store talks to Rust over IPC; here only the calls the tested actions make are stubbed.
const ipc = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  label: 'main',
  openWindow: vi.fn<(handoff?: unknown) => Promise<string>>(async () => 'window-1'),
  handoff: null as unknown,
  closeSession: vi.fn<(id: string) => Promise<undefined>>(async () => undefined),
}));
vi.mock('./lib/ipc', () => ({
  api: {
    appInfo: async () => ({ version: 'test' }),
    getSettings: async () => ipc.settings,
    listConnections: async () => [],
    openWindow: ipc.openWindow,
    takeWindowHandoff: async () => {
      const h = ipc.handoff;
      ipc.handoff = null;
      return h;
    },
    closeSession: ipc.closeSession,
    useSchema: async () => undefined,
    listObjects: vi.fn(async (): Promise<unknown[]> => []),
  },
  IpcError: Error,
}));
const updateChecks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('./lib/updates', () => ({ startUpdateChecks: updateChecks.start }));
vi.mock('./lib/windows', async (orig) => ({ ...(await orig<typeof import('./lib/windows')>()), currentWindowLabel: () => ipc.label }));

import { readHandoff, restoreWorkspace, tabInView, useApp, workspaceSnapshot, type OpenSession, type Tab } from './store';
import { persistsWorkspace, windowTitle } from './lib/windows';

const reset = () => useApp.setState({ tabs: [], activeTab: undefined, closedTabs: [], sessions: {}, activeSession: undefined, toasts: [] });

describe('split editor state', () => {
  beforeEach(reset);

  it('toggles a query tab between single, right and down layouts', () => {
    const id = useApp.getState().openTab({ kind: 'query', title: 'Q', sql: 'select 1' });
    const tab = () => useApp.getState().tabs.find((t) => t.id === id)!;
    useApp.getState().toggleSplit(id);
    expect(tab().split).toBe('right');
    expect(tab().sql2).toBe('');
    useApp.getState().toggleSplit(id, 'down');
    expect(tab().split).toBe('down');
    useApp.getState().toggleSplit(id, 'down');
    expect(tab().split).toBeUndefined();
    expect(tab().sql).toBe('select 1');
  });

  it('keeps the second pane text when the split is closed and reopened', () => {
    const id = useApp.getState().openTab({ kind: 'query', title: 'Q', sql: 'a' });
    useApp.getState().toggleSplit(id, 'right');
    useApp.getState().updateTab(id, { sql2: 'select 2' });
    useApp.getState().toggleSplit(id);
    useApp.getState().toggleSplit(id);
    const t = useApp.getState().tabs.find((x) => x.id === id)!;
    expect(t.split).toBe('right');
    expect(t.sql2).toBe('select 2');
  });

  it('only splits query tabs', () => {
    const id = useApp.getState().openTab({ kind: 'settings', title: 'Settings' });
    useApp.getState().toggleSplit(id);
    expect(useApp.getState().tabs[0].split).toBeUndefined();
  });

  it('persists and restores split layout and both panes with the tab', () => {
    const tabs: Tab[] = [
      { id: 'q1', kind: 'query', title: 'Q1', sql: 'select 1', sql2: 'select 2', split: 'down', sessionId: 's1' },
      { id: 'q2', kind: 'query', title: 'Q2', sql: 'x' },
      { id: 't1', kind: 'table', title: 'users', sessionId: 's1', target: { schema: null, table: 'users' } },
    ];
    const saved = JSON.parse(JSON.stringify(workspaceSnapshot(tabs)));
    expect(saved).toHaveLength(2);
    expect(saved[0]).not.toHaveProperty('sessionId');
    const restored = restoreWorkspace(saved);
    expect(restored[0]).toMatchObject({ id: 'q1', sql: 'select 1', sql2: 'select 2', split: 'down', sessionId: undefined });
    expect(restored[1].split).toBeUndefined();
    // Junk in the saved setting is ignored.
    expect(restoreWorkspace([{ id: 'z', kind: 'query', split: 'diagonal' }, null, { kind: 'table', id: 'y' }])).toEqual([{ id: 'z', kind: 'query', split: undefined, sessionId: undefined }]);
    expect(restoreWorkspace('nope')).toEqual([]);
  });
});

describe('window-scoped workspace', () => {
  beforeEach(reset);
  const saved = [{ id: 'q1', kind: 'query', title: 'Saved', sql: 'select 42', split: 'right', sql2: 'select 43' }];

  it('the main window restores the saved tabs', async () => {
    ipc.label = 'main';
    ipc.settings = { 'workspace.tabs': saved };
    await useApp.getState().init();
    expect(useApp.getState().tabs.map((t) => t.title)).toEqual(['Saved']);
    expect(useApp.getState().tabs[0].split).toBe('right');
    expect(useApp.getState().activeTab).toBe('q1');
    expect(updateChecks.start).toHaveBeenCalledTimes(1);
  });

  it('a secondary window starts with an empty workspace and does not persist', async () => {
    ipc.label = 'window-3';
    ipc.settings = { 'workspace.tabs': saved };
    await useApp.getState().init();
    expect(useApp.getState().tabs).toEqual([]);
    expect(persistsWorkspace('window-3')).toBe(false);
    expect(persistsWorkspace('main')).toBe(true);
    // Only the main window checks for updates.
    expect(updateChecks.start).not.toHaveBeenCalled();
  });

  it('opens a new window through the backend and reports failures', async () => {
    await useApp.getState().openWindow();
    expect(ipc.openWindow).toHaveBeenCalledTimes(1);
    ipc.openWindow.mockRejectedValueOnce(new Error('no window for you'));
    await useApp.getState().openWindow();
    expect(useApp.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'no window for you' });
  });

  it('titles windows "Lord of the Rows — <connection>"', () => {
    expect(windowTitle('Lord of the Rows', 'Prod DB')).toBe('Lord of the Rows — Prod DB');
    expect(windowTitle('Lord of the Rows')).toBe('Lord of the Rows');
  });
});

describe('openConnection', () => {
  it('switches to a connection already open in this window and ignores repeats while connecting', async () => {
    let resolve!: (id: string) => void;
    const openSession = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const switchSession = vi.fn();
    useApp.setState({ sessions: {}, openSession, switchSession } as never);
    const first = useApp.getState().openConnection('c1');
    expect(await useApp.getState().openConnection('c1')).toBeNull();
    resolve('s1');
    expect(await first).toBe('s1');
    expect(openSession).toHaveBeenCalledTimes(1);

    useApp.setState({ sessions: { s1: { session_id: 's1', config: { id: 'c1' } } } } as never);
    expect(await useApp.getState().openConnection('c1')).toBe('s1');
    expect(switchSession).toHaveBeenCalledWith('s1');
    expect(openSession).toHaveBeenCalledTimes(1);
  });
});

describe('update available', () => {
  beforeEach(() => {
    reset();
    useApp.setState({ update: null, settingsSection: null, toasts: [] });
  });
  const avail = (version: string) => ({ status: 'available' as const, channel: 'stable' as const, current_version: '0.2.0', version });

  it('remembers a found release and announces each new version once', () => {
    const st = useApp.getState();
    st.setUpdateResult(avail('0.2.1'));
    st.setUpdateResult(avail('0.2.1'));
    expect(useApp.getState().update?.version).toBe('0.2.1');
    expect(useApp.getState().toasts).toHaveLength(1);
    st.setUpdateResult(avail('0.2.2'));
    expect(useApp.getState().toasts).toHaveLength(2);
    st.setUpdateResult({ status: 'up_to_date', channel: 'stable', current_version: '0.2.2' });
    expect(useApp.getState().update).toBeNull();
  });

  it('the toast action opens Settings at the Updates section', () => {
    useApp.getState().setUpdateResult(avail('0.2.1'));
    useApp.getState().toasts[0].action!.run();
    const st = useApp.getState();
    expect(st.settingsSection).toBe('updates');
    expect(st.tabs.find((t) => t.id === st.activeTab)?.kind).toBe('settings');
  });
});

describe('move / open a connection in a new window', () => {
  beforeEach(() => {
    reset();
    ipc.label = 'main';
    ipc.handoff = null;
    ipc.openWindow.mockClear();
    ipc.closeSession.mockClear();
  });
  const session = (id: string, connId: string) => ({ session_id: id, config: { id: connId, name: connId }, activeSchema: 'shop', schemas: ['public', 'shop'] }) as unknown as OpenSession;

  it('"Move to new window" hands over the query and table tabs, then closes the connection here', async () => {
    useApp.setState({
      sessions: { s1: session('s1', 'c1'), s2: session('s2', 'c2') },
      activeSession: 's1',
      tabs: [
        { id: 'q1', kind: 'query', title: 'Q', sql: 'select 1', sessionId: 's1' },
        { id: 't1', kind: 'table', title: 'orders', sessionId: 's1', target: { schema: 'shop', table: 'orders' } },
        { id: 'q2', kind: 'query', title: 'Other', sql: 'select 2', sessionId: 's2' },
      ],
    });
    await useApp.getState().openSessionInNewWindow('s1', true);
    expect(ipc.openWindow).toHaveBeenCalledWith({
      connectionId: 'c1',
      schema: 'shop',
      queryTabs: [expect.objectContaining({ id: 'q1', sql: 'select 1' })],
      tableTabs: [{ title: 'orders', target: { schema: 'shop', table: 'orders' } }],
    });
    expect(ipc.closeSession).toHaveBeenCalledWith('s1');
    expect(Object.keys(useApp.getState().sessions)).toEqual(['s2']);
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(['q2']);
  });

  it('"Open in new window" keeps everything here and sends only the connection', async () => {
    useApp.setState({ sessions: { s1: session('s1', 'c1') }, tabs: [{ id: 'q1', kind: 'query', title: 'Q', sessionId: 's1' }] });
    await useApp.getState().openSessionInNewWindow('s1', false);
    expect(ipc.openWindow).toHaveBeenCalledWith({ connectionId: 'c1', schema: 'shop', queryTabs: [], tableTabs: [] });
    expect(ipc.closeSession).not.toHaveBeenCalled();
    expect(useApp.getState().tabs).toHaveLength(1);
  });

  it('nothing is closed when the new window cannot be opened', async () => {
    useApp.setState({ sessions: { s1: session('s1', 'c1') }, tabs: [] });
    ipc.openWindow.mockRejectedValueOnce(new Error('no window'));
    await useApp.getState().openSessionInNewWindow('s1', true);
    expect(ipc.closeSession).not.toHaveBeenCalled();
    expect(useApp.getState().sessions.s1).toBeTruthy();
    expect(useApp.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'no window' });
  });

  it('a new window opens the handed-over connection, its database and tabs', async () => {
    ipc.label = 'window-2';
    ipc.handoff = { connectionId: 'c1', schema: 'shop', queryTabs: [{ id: 'q1', kind: 'query', title: 'Q', sql: 'select 1', sessionId: 'old' }], tableTabs: [{ title: 'orders', target: { schema: 'shop', table: 'orders' } }] };
    const openConnection = vi.fn(async () => {
      useApp.setState({ sessions: { s9: session('s9', 'c1') } });
      return 's9';
    });
    const setActiveSchema = vi.fn();
    useApp.setState({ openConnection, setActiveSchema } as never);
    await useApp.getState().init();
    expect(openConnection).toHaveBeenCalledWith('c1');
    expect(setActiveSchema).toHaveBeenCalledWith('s9', 'shop');
    const tabs = useApp.getState().tabs;
    expect(tabs[0]).toMatchObject({ id: 'q1', sql: 'select 1', sessionId: undefined });
    expect(tabs.find((t) => t.kind === 'table')).toMatchObject({ title: 'orders', sessionId: 's9' });
  });

  it('ignores a hand-off that is not well-formed', () => {
    expect(readHandoff(null)).toBeNull();
    expect(readHandoff({ connectionId: '' })).toBeNull();
    expect(readHandoff({ connectionId: 'c1', tableTabs: [{ title: 'x' }, { title: 'y', target: { table: 't' } }] })?.tableTabs).toEqual([{ title: 'y', target: { table: 't' } }]);
  });

  it('closes every other connection', async () => {
    useApp.setState({ sessions: { s1: session('s1', 'c1'), s2: session('s2', 'c2'), s3: session('s3', 'c3') }, tabs: [] });
    await useApp.getState().closeOtherSessions('s2');
    expect(Object.keys(useApp.getState().sessions)).toEqual(['s2']);
    expect(ipc.closeSession.mock.calls.map((c) => c[0]).sort()).toEqual(['s1', 's3']);
  });
});

describe('tabs belong to the database they were opened for', () => {
  const sess = (id: string, schema: string) => ({ session_id: id, config: { id: `c-${id}`, name: id }, activeSchema: schema, schemas: ['prd', 'stg'], objects: { prd: [], stg: [] } }) as unknown as OpenSession;
  // An earlier test replaces these actions with mocks; use the real ones (captured at load).
  const real = { setActiveSchema: useApp.getState().setActiveSchema, openTab: useApp.getState().openTab, updateTab: useApp.getState().updateTab };
  const visible = () => {
    const st = useApp.getState();
    return st.tabs.filter((t) => tabInView(t, st)).map((t) => t.title);
  };
  beforeEach(() => {
    reset();
    useApp.setState({ ...real, sessions: { s1: sess('s1', 'prd') }, activeSession: 's1', lastTab: {} });
  });

  it('a query tab opened in one database is hidden in another, and comes back with it', () => {
    const { openTab, setActiveSchema } = useApp.getState();
    const a = openTab({ kind: 'query', title: 'A', sessionId: 's1', sql: 'select 1' });
    openTab({ kind: 'settings', title: 'Settings' });
    expect(useApp.getState().tabs.find((t) => t.id === a)?.schema).toBe('prd');
    useApp.setState({ activeTab: a });

    // The other database has no tabs yet: it starts with an empty query tab of its own.
    setActiveSchema('s1', 'stg');
    expect(visible()).toEqual(['Settings', 'Query']);
    const b = useApp.getState().activeTab;
    expect(useApp.getState().tabs.find((t) => t.id === b)).toMatchObject({ kind: 'query', sessionId: 's1', schema: 'stg', sql: '' });

    setActiveSchema('s1', 'prd');
    expect(visible()).toEqual(['A', 'Settings']);
    expect(useApp.getState().activeTab).toBe(a);
    setActiveSchema('s1', 'stg');
    expect(useApp.getState().activeTab).toBe(b);
  });

  it('tabs without a database (restored, or opened before) show everywhere; binding a tab sets its database', () => {
    useApp.setState({ tabs: [{ id: 'r', kind: 'query', title: 'R', sql: '' }], activeTab: 'r' });
    useApp.getState().setActiveSchema('s1', 'stg');
    expect(visible()).toEqual(['R']);
    useApp.getState().updateTab('r', { sessionId: 's1' });
    expect(useApp.getState().tabs[0].schema).toBe('stg');
    useApp.getState().setActiveSchema('s1', 'prd');
    expect(visible()).toEqual(['Query']);
  });
});

describe('loadObjects', () => {
  it('a failed refresh shows a toast instead of an unhandled error, and keeps the tree', async () => {
    reset();
    const sess = { session_id: 's1', config: { name: 'x' }, activeSchema: 'shop', schemas: ['shop'], objects: { shop: [{ kind: 'table', name: 'orders' }] } } as unknown as OpenSession;
    useApp.setState({ sessions: { s1: sess } });
    const { api } = await import('./lib/ipc');
    vi.mocked(api.listObjects).mockRejectedValueOnce(new Error('Connection to the server is closed.'));
    await expect(useApp.getState().loadObjects('s1', 'shop')).resolves.toBeUndefined();
    expect(useApp.getState().toasts.map((t) => t.text)).toContain('Connection to the server is closed.');
    expect(useApp.getState().sessions.s1.objects.shop).toHaveLength(1);
  });
});

