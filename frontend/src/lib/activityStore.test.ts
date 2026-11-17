import { describe, expect, it, vi } from 'vitest';

vi.mock('./ipc', () => ({ api: {} }));

import { pollMs, sessionActivity, useActivity } from './activityStore';
import type { ActivityRow } from './types';

const row = { id: '1', stop: { impact: 'idle', severity: 'safe', kill_discards_transaction: false, can_cancel: false, can_kill: true } } as ActivityRow;

describe('activity store', () => {
  it('loads the processes of a session and keeps the last list when a refresh fails', async () => {
    const listDbSessions = vi.fn().mockResolvedValueOnce([row]).mockRejectedValueOnce(new Error('connection lost'));
    await useActivity.getState().refresh('s1', { api: { listDbSessions } });
    expect(sessionActivity(useActivity.getState(), 's1')).toMatchObject({ rows: [row], error: null, loading: false });
    await useActivity.getState().refresh('s1', { api: { listDbSessions } });
    expect(sessionActivity(useActivity.getState(), 's1')).toMatchObject({ rows: [row], error: 'connection lost' });
    expect(sessionActivity(useActivity.getState(), undefined).rows).toEqual([]);
  });

  it('does not stack requests for the same session', async () => {
    let release!: () => void;
    const listDbSessions = vi.fn(() => new Promise<ActivityRow[]>((r) => (release = () => r([]))));
    const a = useActivity.getState().refresh('s2', { api: { listDbSessions } });
    await useActivity.getState().refresh('s2', { api: { listDbSessions } });
    release();
    await a;
    expect(listDbSessions).toHaveBeenCalledTimes(1);
  });

  it('polls fast while shown, gently on production, slowly for the indicator', () => {
    expect(pollMs(true, false)).toBe(3000);
    expect(pollMs(true, true)).toBe(5000);
    expect(pollMs(false, false)).toBe(20_000);
  });
});
