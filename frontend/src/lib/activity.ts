// Pure helpers for Activity (live server sessions): grouping, filtering, summary.
import type { ActivityRow, StopSeverity } from './types';

/** Running longer than this turns the indicator amber… */
export const WARN_MS = 30_000;
/** …and longer than this red. */
export const ALERT_MS = 5 * 60_000;

/** A statement is executing (not idle, not a sleeping connection). */
export const isRunning = (r: ActivityRow) => r.stop.can_cancel || (r.stop.impact === 'backup');

export interface ActivityFilter {
  search: string;
  database: string | null;
  user: string | null;
  showIdle: boolean;
}

export const EMPTY_FILTER: ActivityFilter = { search: '', database: null, user: null, showIdle: false };

export function matches(r: ActivityRow, f: ActivityFilter): boolean {
  if (f.database && r.database !== f.database) return false;
  if (f.user && r.user !== f.user) return false;
  const q = f.search.trim().toLowerCase();
  if (!q) return true;
  return [r.id, r.user, r.database, r.client, r.query, r.state, r.command].some((x) => x?.toLowerCase().includes(q));
}

const blockedBy = (r: ActivityRow) => (r.blocked_by ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export interface BlockChain {
  blocker: ActivityRow;
  waiters: ActivityRow[];
}

export interface ActivityGroups {
  /** Sessions holding locks others wait for, each with its waiters (the cause first). */
  blocking: BlockChain[];
  /** Running statements not involved in a lock wait, longest first. */
  running: ActivityRow[];
  /** Idle sessions (shown only when asked; counted otherwise). */
  idle: ActivityRow[];
  idleCount: number;
}

const longestFirst = (a: ActivityRow, b: ActivityRow) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0);

/** Splits sessions into lock chains, running and idle, applying the filter. */
export function groupActivity(rows: ActivityRow[], f: ActivityFilter): ActivityGroups {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const waitersOf = new Map<string, ActivityRow[]>();
  for (const r of rows) for (const b of blockedBy(r)) if (byId.has(b)) waitersOf.set(b, [...(waitersOf.get(b) ?? []), r]);
  // The root causes: blockers that are not themselves waiting on another blocker.
  const inChain = new Set<string>();
  const blocking: BlockChain[] = [];
  for (const [id, waiters] of waitersOf) {
    const blocker = byId.get(id)!;
    const all = [blocker, ...waiters];
    if (!all.some((x) => matches(x, f))) continue;
    blocking.push({ blocker, waiters: [...waiters].sort(longestFirst) });
    all.forEach((x) => inChain.add(x.id));
  }
  blocking.sort((a, b) => b.waiters.length - a.waiters.length || longestFirst(a.blocker, b.blocker));
  const rest = rows.filter((r) => !inChain.has(r.id) && matches(r, f));
  const running = rest.filter(isRunning).sort(longestFirst);
  const idleAll = rest.filter((r) => !isRunning(r)).sort(longestFirst);
  return { blocking, running, idle: f.showIdle ? idleAll : [], idleCount: idleAll.length };
}

export interface ActivitySummary {
  running: number;
  blocked: number;
  longestMs: number;
  level: 'ok' | 'warn' | 'alert';
}

/** For the status-bar indicator. Server threads (always "running") are left out. */
export function summarize(rows: ActivityRow[]): ActivitySummary {
  const user = rows.filter((r) => !r.system);
  const running = user.filter(isRunning);
  const blocked = user.filter((r) => blockedBy(r).length > 0).length;
  const longestMs = Math.max(0, ...running.map((r) => r.duration_ms ?? 0));
  const level = blocked > 0 || longestMs >= ALERT_MS ? 'alert' : longestMs >= WARN_MS ? 'warn' : 'ok';
  return { running: running.length, blocked, longestMs, level };
}

/** "0.4s", "38s", "4m 12s", "2h 3m". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Duration bar: share of ALERT_MS (log-ish so short queries still show), and its level. */
export function durationLevel(ms: number | null | undefined): { pct: number; level: 'ok' | 'warn' | 'alert' } {
  const v = Math.max(0, ms ?? 0);
  const pct = Math.min(100, Math.round((Math.log10(1 + v / 100) / Math.log10(1 + ALERT_MS / 100)) * 100));
  return { pct, level: v >= ALERT_MS ? 'alert' : v >= WARN_MS ? 'warn' : 'ok' };
}

const RANK: Record<StopSeverity, number> = { safe: 0, caution: 1, danger: 2, blocked: 3 };

/** The worst severity among the sessions about to be stopped. */
export function worstSeverity(rows: ActivityRow[], mode: 'query' | 'connection'): StopSeverity {
  let w: StopSeverity = 'safe';
  for (const r of rows) {
    // Ending the connection also undoes the open transaction.
    const s = mode === 'connection' && r.stop.kill_discards_transaction && r.stop.severity === 'safe' ? 'caution' : r.stop.severity;
    if (RANK[s] > RANK[w]) w = s;
  }
  return w;
}

/** Sessions among `rows` that `mode` can act on. */
export const actionable = (rows: ActivityRow[], mode: 'query' | 'connection') => rows.filter((r) => (mode === 'query' ? r.stop.can_cancel : r.stop.can_kill));

/** Distinct databases and users, for the filter menus. */
export function facets(rows: ActivityRow[]): { databases: string[]; users: string[] } {
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
  return { databases: uniq(rows.map((r) => r.database)), users: uniq(rows.map((r) => r.user)) };
}
