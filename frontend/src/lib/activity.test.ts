import { describe, expect, it } from 'vitest';
import { ALERT_MS, EMPTY_FILTER, actionable, durationLevel, facets, fmtDuration, groupActivity, summarize, worstSeverity } from './activity';
import type { ActivityRow, StopAssessment } from './types';

const stop = (o: Partial<StopAssessment> = {}): StopAssessment => ({ impact: 'nothing_to_undo', severity: 'safe', kill_discards_transaction: false, rows: null, can_cancel: true, can_kill: true, ...o });
const run = (id: string, ms: number, o: Partial<ActivityRow> = {}): ActivityRow => ({ id, query: `SELECT ${id}`, duration_ms: ms, user: 'app', database: 'core', stop: stop(), ...o });
const idle = (id: string, o: Partial<ActivityRow> = {}): ActivityRow => ({ id, command: 'Sleep', duration_ms: 1000, user: 'app', database: 'core', stop: stop({ impact: 'idle', can_cancel: false }), ...o });

describe('groupActivity', () => {
  it('puts lock chains first (cause with its waiters), then running longest first; idle is counted', () => {
    const rows = [run('1', 500), run('2', 90_000), idle('3'), idle('4'), run('10', 250_000), run('11', 180_000, { blocked_by: '10' }), run('12', 60_000, { blocked_by: '10' })];
    const g = groupActivity(rows, EMPTY_FILTER);
    expect(g.blocking.map((c) => [c.blocker.id, c.waiters.map((w) => w.id)])).toEqual([['10', ['11', '12']]]);
    expect(g.running.map((r) => r.id)).toEqual(['2', '1']);
    expect(g.idle).toEqual([]);
    expect(g.idleCount).toBe(2);
    expect(groupActivity(rows, { ...EMPTY_FILTER, showIdle: true }).idle.map((r) => r.id)).toEqual(['3', '4']);
  });

  it('filters by search text, database and user, keeping a chain when any member matches', () => {
    const rows = [run('1', 1, { query: 'UPDATE orders SET x=1', database: 'core' }), run('2', 1, { database: 'prio', user: 'etl' }), run('3', 1, { blocked_by: '1', query: 'SELECT * FROM invoices' })];
    expect(groupActivity(rows, { ...EMPTY_FILTER, search: 'invoices' }).blocking).toHaveLength(1);
    expect(groupActivity(rows, { ...EMPTY_FILTER, database: 'prio' }).running.map((r) => r.id)).toEqual(['2']);
    expect(groupActivity(rows, { ...EMPTY_FILTER, user: 'etl' }).blocking).toHaveLength(0);
    expect(facets(rows)).toEqual({ databases: ['core', 'prio'], users: ['app', 'etl'] });
  });

  it('ignores waits on sessions that are no longer listed', () => {
    const g = groupActivity([run('3', 1, { blocked_by: '99' })], EMPTY_FILTER);
    expect(g.blocking).toEqual([]);
    expect(g.running.map((r) => r.id)).toEqual(['3']);
  });
});

describe('summarize', () => {
  it('counts running and blocked user sessions and leaves server threads out', () => {
    const sys = run('5', 9_000_000, { system: true, stop: stop({ impact: 'system', severity: 'blocked', can_cancel: false, can_kill: false }) });
    expect(summarize([sys, idle('1')])).toEqual({ running: 0, blocked: 0, longestMs: 0, level: 'ok' });
    expect(summarize([run('1', 45_000)]).level).toBe('warn');
    expect(summarize([run('1', ALERT_MS)]).level).toBe('alert');
    expect(summarize([run('1', 1), run('2', 1, { blocked_by: '1' })])).toMatchObject({ running: 2, blocked: 1, level: 'alert' });
  });
});

describe('stopping', () => {
  it('rates a selection by its worst case; killing an open transaction is never "safe"', () => {
    const write = run('2', 1, { stop: stop({ impact: 'undo_write', severity: 'caution' }) });
    const trx = run('3', 1, { stop: stop({ kill_discards_transaction: true }) });
    expect(worstSeverity([run('1', 1)], 'query')).toBe('safe');
    expect(worstSeverity([run('1', 1), write], 'query')).toBe('caution');
    expect(worstSeverity([trx], 'query')).toBe('safe');
    expect(worstSeverity([trx], 'connection')).toBe('caution');
  });

  it('only acts on sessions the action applies to', () => {
    const own = run('1', 1, { own: true, stop: stop({ can_kill: false }) });
    expect(actionable([own, idle('2')], 'query').map((r) => r.id)).toEqual(['1']);
    expect(actionable([own, idle('2')], 'connection').map((r) => r.id)).toEqual(['2']);
  });
});

describe('formatting', () => {
  it('formats durations compactly', () => {
    expect(fmtDuration(400)).toBe('0.4s');
    expect(fmtDuration(38_000)).toBe('38s');
    expect(fmtDuration(252_000)).toBe('4m 12s');
    expect(fmtDuration(7_380_000)).toBe('2h 3m');
    expect(fmtDuration(null)).toBe('');
  });

  it('scales the duration bar and colours it by threshold', () => {
    expect(durationLevel(0)).toEqual({ pct: 0, level: 'ok' });
    expect(durationLevel(40_000).level).toBe('warn');
    expect(durationLevel(ALERT_MS * 2)).toEqual({ pct: 100, level: 'alert' });
    expect(durationLevel(1000).pct).toBeGreaterThan(0);
  });
});
