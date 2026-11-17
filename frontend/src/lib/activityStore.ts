import { create } from 'zustand';
import { api } from './ipc';
import type { ActivityRow } from './types';

export interface SessionActivity {
  rows: ActivityRow[];
  at: number;
  error: string | null;
  loading: boolean;
}

interface ActivityState {
  /** The Activity panel is shown. */
  open: boolean;
  /** Updates are held while the user is pointing at / selecting rows, so nothing jumps under the cursor. */
  frozen: boolean;
  bySession: Record<string, SessionActivity>;
  setOpen(open: boolean): void;
  toggle(): void;
  setFrozen(frozen: boolean): void;
  refresh(sessionId: string, deps?: { api: Pick<typeof api, 'listDbSessions'> }): Promise<void>;
}

const EMPTY: SessionActivity = { rows: [], at: 0, error: null, loading: false };
export const sessionActivity = (s: ActivityState, id: string | undefined): SessionActivity => (id ? (s.bySession[id] ?? EMPTY) : EMPTY);

export const useActivity = create<ActivityState>((set, get) => ({
  open: false,
  frozen: false,
  bySession: {},
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
  setFrozen: (frozen) => set({ frozen }),
  async refresh(sessionId, deps = { api }) {
    const prev = get().bySession[sessionId] ?? EMPTY;
    if (prev.loading) return;
    set({ bySession: { ...get().bySession, [sessionId]: { ...prev, loading: true } } });
    try {
      const rows = await deps.api.listDbSessions(sessionId);
      set({ bySession: { ...get().bySession, [sessionId]: { rows, at: Date.now(), error: null, loading: false } } });
    } catch (e) {
      const error = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
      set({ bySession: { ...get().bySession, [sessionId]: { ...(get().bySession[sessionId] ?? EMPTY), error, loading: false } } });
    }
  },
}));

/** Poll intervals: panel shown (production gets a gentler rate) vs. the status-bar indicator only. */
export const pollMs = (shown: boolean, production: boolean) => (shown ? (production ? 5000 : 3000) : 20_000);
