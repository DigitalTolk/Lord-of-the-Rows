// Activity: what is running on the server right now, what is stuck, and stopping it safely.
// Each process carries a stop assessment from the backend (dbs_safety::stop) saying what
// cancelling its query or killing its connection would do, shown before you click.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { EMPTY_FILTER, actionable, durationLevel, facets, fmtDuration, groupActivity, summarize, worstSeverity, type ActivityFilter } from '../lib/activity';
import { pollMs, sessionActivity, useActivity } from '../lib/activityStore';
import { fmtNumber } from '../lib/format';
import { api } from '../lib/ipc';
import { displayCombo, DEFAULT_KEYS } from '../lib/keys';
import type { ActivityRow, StopMode, StopSeverity } from '../lib/types';
import { errMsg, useApp, type OpenSession } from '../store';
import { Icon } from './icons';
import { Dialog } from './ui';

const SEV_CLASS: Record<StopSeverity, string> = {
  safe: 'bg-ok/12 text-ok',
  caution: 'bg-warn/15 text-warn',
  danger: 'bg-danger/12 text-danger',
  blocked: 'bg-hover text-muted',
};
const LEVEL_BAR = { ok: 'bg-ok/70', warn: 'bg-warn', alert: 'bg-danger-solid' } as const;

const monitorable = (s: OpenSession | undefined) => !!s?.capabilities.sessions_monitor;

/** Keeps the active session's process list fresh: fast while Activity is shown, slow for the indicator. */
export function ActivityPoller() {
  const s = useApp((x) => (x.activeSession ? x.sessions[x.activeSession] : undefined));
  const monitorShown = useApp((x) => x.tabs.find((t) => t.id === x.activeTab)?.kind === 'monitor');
  const open = useActivity((x) => x.open);
  const frozen = useActivity((x) => x.frozen);
  const id = monitorable(s) ? s!.session_id : undefined;
  const shown = open || monitorShown;
  const ms = pollMs(shown, s?.config.environment === 'production');
  useEffect(() => {
    if (!id || frozen) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void useActivity.getState().refresh(id);
    };
    tick();
    const h = setInterval(tick, ms);
    return () => clearInterval(h);
  }, [id, ms, frozen]);
  return null;
}

/** Status-bar indicator: "● 3 running · 1 blocked"; amber for long queries, red for blocked ones. */
export function ActivityIndicator() {
  const { t } = useTranslation();
  const s = useApp((x) => (x.activeSession ? x.sessions[x.activeSession] : undefined));
  const data = useActivity((x) => sessionActivity(x, s?.session_id));
  const toggle = useActivity((x) => x.toggle);
  if (!monitorable(s)) return null;
  const sum = summarize(data.rows);
  const color = sum.level === 'alert' ? 'text-danger' : sum.level === 'warn' ? 'text-warn' : sum.running ? 'text-ok' : 'text-muted';
  const label = data.at === 0 ? t('activity.title') : sum.running === 0 ? t('activity.nothingRunning') : t('activity.runningCount', { count: sum.running, formatted: fmtNumber(sum.running) });
  return (
    <button className={`flex items-center gap-1 hover:text-fg ${color}`} title={`${t('activity.title')} (${displayCombo(DEFAULT_KEYS.activity)})`} onClick={toggle}>
      <span aria-hidden>●</span>
      <span>{label}</span>
      {sum.blocked > 0 && <span className="font-semibold">· {t('activity.blockedCount', { count: sum.blocked, formatted: fmtNumber(sum.blocked) })}</span>}
    </button>
  );
}

/** Side panel next to the work (not a modal): Activity for the active session. */
export function ActivityPanel() {
  const { t } = useTranslation();
  const open = useActivity((x) => x.open);
  const setOpen = useActivity((x) => x.setOpen);
  const s = useApp((x) => (x.activeSession ? x.sessions[x.activeSession] : undefined));
  if (!open) return null;
  return (
    <aside
      aria-label={t('activity.title')}
      className="fixed bottom-[22px] end-0 top-[44px] z-40 flex w-[min(620px,100vw)] flex-col border-s border-border bg-panel shadow-2xl"
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="pulse" size={15} />
        <h2 className="font-semibold">{t('activity.title')}</h2>
        {s && <span className="truncate text-muted">· {s.config.name}</span>}
        <button className="icon-btn ms-auto" aria-label={t('common.close')} title={t('common.close')} onClick={() => setOpen(false)}>
          <Icon name="x" size={14} />
        </button>
      </header>
      {s && monitorable(s) ? <ActivityList session={s} /> : <p className="p-4 text-muted">{s ? t('monitor.unsupported') : t('status.disconnected')}</p>}
    </aside>
  );
}

function ImpactBadge({ row }: { row: ActivityRow }) {
  const { t } = useTranslation();
  const { stop } = row;
  const text = stop.impact === 'undo_write' && stop.rows ? t('activity.undoWriteRows', { count: stop.rows, formatted: stop.rows.toLocaleString() }) : t(`activity.impact.${stop.impact}`);
  return (
    <span className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[0.72rem] font-medium ${SEV_CLASS[stop.severity]}`} title={t(`activity.explain.${stop.impact}`)}>
      {text}
    </span>
  );
}

function DurationBar({ ms }: { ms: number | null | undefined }) {
  const { pct, level } = durationLevel(ms);
  return (
    <span className="flex w-24 shrink-0 items-center gap-1.5" aria-hidden>
      <span className="h-1.5 flex-1 overflow-hidden rounded bg-hover">
        <span className={`block h-full ${LEVEL_BAR[level]}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`w-12 text-end font-mono text-[0.75rem] ${level === 'alert' ? 'text-danger' : level === 'warn' ? 'text-warn' : 'text-muted'}`}>{fmtDuration(ms)}</span>
    </span>
  );
}

interface StopRequest {
  mode: StopMode;
  rows: ActivityRow[];
  resolve: (ok: boolean) => void;
}

/** Confirmation that says exactly what will happen to each process. */
function StopDialog({ req, session }: { req: StopRequest; session: OpenSession }) {
  const { t } = useTranslation();
  const sev = worstSeverity(req.rows, req.mode);
  const production = session.config.environment === 'production';
  // Typed confirmation when it can leave data half-changed or break a backup, or on production.
  const typed = sev === 'danger' || (production && req.mode === 'connection');
  const [text, setText] = useState('');
  const ok = !typed || text.trim() === session.config.name;
  const title = t(req.mode === 'query' ? 'activity.confirmCancelTitle' : 'activity.confirmKillTitle', { count: req.rows.length, formatted: fmtNumber(req.rows.length) });
  return (
    <Dialog
      title={title}
      onClose={() => req.resolve(false)}
      wide
      footer={
        <>
          <button className="btn" onClick={() => req.resolve(false)}>{t('common.cancel')}</button>
          <button className={`btn ${sev === 'safe' ? 'btn-primary' : 'btn-danger'}`} disabled={!ok} onClick={() => req.resolve(true)}>
            {req.mode === 'query' ? t('activity.cancelQuery') : t('activity.killConnection')}
          </button>
        </>
      }
    >
      <p className="mb-2 text-sm">{t(req.mode === 'query' ? 'activity.cancelHint' : 'activity.killHint')}</p>
      <ul className="mb-3 max-h-72 space-y-2 overflow-auto">
        {req.rows.map((r) => (
          <li key={r.id} className="rounded border border-border p-2">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted">
              <span className="font-mono">#{r.id}</span>
              <span className="truncate">{r.user}{r.client ? `@${r.client}` : ''}{r.database ? ` · ${r.database}` : ''}</span>
              <span className="ms-auto"><ImpactBadge row={r} /></span>
            </div>
            {r.query && <code dir="ltr" className="block max-h-16 overflow-hidden whitespace-pre-wrap break-all font-mono text-xs">{r.query}</code>}
            <p className="mt-1 text-xs">{t(`activity.explain.${r.stop.impact}`)}</p>
            {req.mode === 'connection' && r.stop.kill_discards_transaction && (
              <p className="mt-1 text-xs text-warn">{r.stop.rows ? t('activity.killDiscardsRows', { count: r.stop.rows, formatted: r.stop.rows.toLocaleString() }) : t('activity.killDiscards')}</p>
            )}
          </li>
        ))}
      </ul>
      {typed && (
        <label className="block text-sm">
          {t('activity.typeName', { name: session.config.name })}
          <input className="input mt-1" value={text} data-autofocus aria-label={t('activity.typeName', { name: session.config.name })} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
    </Dialog>
  );
}

function Row({
  row,
  nested,
  selected,
  expanded,
  focused,
  canStop,
  onSelect,
  onExpand,
  onFocus,
  onStop,
  onOpen,
}: {
  row: ActivityRow;
  nested?: boolean;
  selected: boolean;
  expanded: boolean;
  focused: boolean;
  canStop: string | null;
  onSelect: () => void;
  onExpand: () => void;
  onFocus: () => void;
  onStop: (mode: StopMode) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);
  const waiting = !!row.blocked_by;
  const title = row.query?.trim() || (row.system ? row.command : null) || t('activity.idleLabel', { state: row.state ?? row.command ?? '' });
  const reason = (mode: StopMode) =>
    canStop ?? (mode === 'query' ? (row.stop.can_cancel ? null : t('activity.nothingToCancel')) : row.stop.can_kill ? null : row.own ? t('activity.ownSession') : t('activity.explain.system'));
  return (
    <div className={`border-b border-border/60 ${nested ? 'ms-5 border-s-2 border-s-warn/50' : ''} ${selected ? 'bg-accent/10' : ''}`}>
      <div
        ref={ref}
        role="row"
        aria-selected={selected}
        aria-expanded={expanded}
        tabIndex={focused ? 0 : -1}
        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 outline-none hover:bg-hover focus-visible:bg-hover"
        onClick={onExpand}
        onFocus={onFocus}
      >
        <input
          type="checkbox"
          className="shrink-0"
          checked={selected}
          aria-label={t('activity.select', { id: row.id })}
          onClick={(e) => e.stopPropagation()}
          onChange={onSelect}
        />
        <div className="min-w-0 flex-1">
          <div dir="ltr" className={`truncate font-mono text-[0.82rem] ${row.query ? '' : 'text-muted'}`}>
            {waiting && <span className="me-1 not-italic text-warn" title={t('activity.waitingFor', { ids: row.blocked_by })}>⏳</span>}
            {title}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[0.75rem] text-muted">
            {row.own && <span className="rounded bg-accent/15 px-1 text-accent">{t('activity.you')}</span>}
            {row.system && <span className="rounded bg-hover px-1">{t('activity.system')}</span>}
            <span className="truncate">
              <span className="font-mono">#{row.id}</span> · {row.user ?? '?'}
              {row.client ? `@${row.client}` : ''}
              {row.database ? ` · ${row.database}` : ''}
              {row.state ? ` · ${row.state}` : ''}
            </span>
          </div>
        </div>
        <ImpactBadge row={row} />
        <DurationBar ms={row.duration_ms} />
      </div>
      {expanded && (
        <div className="space-y-2 bg-bg/40 px-3 py-2 text-sm">
          {row.query && <pre dir="ltr" className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-bg p-2 font-mono text-xs">{row.query}</pre>}
          <p className="text-xs">{t(`activity.explain.${row.stop.impact}`)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
            {row.command && (<><dt>{t('activity.command')}</dt><dd>{row.command}</dd></>)}
            {row.in_transaction && (<><dt>{t('activity.transaction')}</dt><dd>{t('activity.trxOpen', { age: fmtDuration(row.trx_age_ms) })}{row.trx_rows_modified ? ` · ${t('activity.trxRows', { count: row.trx_rows_modified, formatted: row.trx_rows_modified.toLocaleString() })}` : row.trx_writes ? ` · ${t('activity.trxWrote')}` : ''}</dd></>)}
            {row.blocked_by && (<><dt>{t('activity.waiting')}</dt><dd>{t('activity.waitingFor', { ids: row.blocked_by })}</dd></>)}
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            {row.query && <button className="btn h-7 text-xs" onClick={() => void navigator.clipboard.writeText(row.query ?? '')}><Icon name="copy" size={12} /> {t('activity.copy')}</button>}
            {row.query && <button className="btn h-7 text-xs" onClick={onOpen}><Icon name="sql" size={12} /> {t('activity.openInEditor')}</button>}
            <span className="ms-auto" />
            <button className="btn h-7 text-xs" disabled={!!reason('query')} title={reason('query') ?? t('activity.cancelHint')} onClick={() => onStop('query')}>
              <Icon name="stop" size={12} /> {t('activity.cancelQuery')}
            </button>
            <button className="btn btn-danger h-7 text-xs" disabled={!!reason('connection')} title={reason('connection') ?? t('activity.killHint')} onClick={() => onStop('connection')}>
              <Icon name="xCircle" size={12} /> {t('activity.killConnection')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The process list: lock chains, running, idle; select, expand, cancel or kill. */
export function ActivityList({ session: s }: { session: OpenSession }) {
  const { t } = useTranslation();
  const data = useActivity((x) => sessionActivity(x, s.session_id));
  const setFrozen = useActivity((x) => x.setFrozen);
  const refresh = () => void useActivity.getState().refresh(s.session_id);
  const toast = useApp((x) => x.toast);
  const [filter, setFilter] = useState<ActivityFilter>(EMPTY_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stopReq, setStopReq] = useState<StopRequest | null>(null);

  // Hold updates while aiming at a row, so it can't move or vanish under the cursor.
  const holding = hover || selected.size > 0 || expanded !== null || stopReq !== null || paused;
  useEffect(() => {
    setFrozen(holding);
  }, [holding, setFrozen]);
  useEffect(() => {
    return () => setFrozen(false);
  }, [setFrozen]);

  const groups = useMemo(() => groupActivity(data.rows, filter), [data.rows, filter]);
  const { databases, users } = useMemo(() => facets(data.rows), [data.rows]);
  const ordered = useMemo(() => [...groups.blocking.flatMap((c) => [c.blocker, ...c.waiters]), ...groups.running, ...groups.idle], [groups]);
  const byId = useMemo(() => new Map(data.rows.map((r) => [r.id, r])), [data.rows]);
  // Read-only connections and engines without termination show the actions disabled, with the reason.
  const canStop = !s.capabilities.kill_session ? t('activity.cannotStopEngine') : s.config.read_only ? t('activity.cannotStopReadOnly') : null;

  const toggleSel = (id: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const stop = async (rows: ActivityRow[], mode: StopMode) => {
    const targets = actionable(rows, mode);
    if (!targets.length) {
      toast('info', t('activity.nothingToStop'));
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => setStopReq({ mode, rows: targets, resolve }));
    setStopReq(null);
    if (!confirmed) return;
    let done = 0;
    const failed: string[] = [];
    for (const r of targets) {
      try {
        const first = await api.killDbSession(s.session_id, r.id, mode);
        if (first.confirm) await api.killDbSession(s.session_id, r.id, mode, first.confirm.token);
        done++;
      } catch (e) {
        failed.push(`#${r.id}: ${errMsg(e)}`);
      }
    }
    if (done) toast('ok', t(mode === 'query' ? 'activity.cancelled' : 'activity.killed', { count: done, formatted: fmtNumber(done) }));
    if (failed.length) toast('error', failed.join('\n'));
    setSelected(new Set());
    setExpanded(null);
    setPaused(false);
    setTimeout(refresh, 300);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (!ordered.length || (e.target as HTMLElement).tagName === 'INPUT') return;
    const i = Math.max(0, ordered.findIndex((r) => r.id === focus));
    const cur = ordered[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus(ordered[Math.min(ordered.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))].id);
    } else if (e.key === ' ') {
      e.preventDefault();
      setExpanded((x) => (x === cur.id ? null : cur.id));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      toggleSel(cur.id);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && !canStop) {
      e.preventDefault();
      const rows = selected.size ? [...selected].map((id) => byId.get(id)).filter((r): r is ActivityRow => !!r) : [cur];
      void stop(rows, e.shiftKey ? 'connection' : 'query');
    }
  };

  const rowProps = (r: ActivityRow) => ({
    row: r,
    selected: selected.has(r.id),
    expanded: expanded === r.id,
    focused: focus === r.id,
    canStop,
    onSelect: () => toggleSel(r.id),
    onExpand: () => setExpanded((x) => (x === r.id ? null : r.id)),
    onFocus: () => setFocus(r.id),
    onStop: (mode: StopMode) => void stop([r], mode),
    onOpen: () => useApp.getState().openTab({ kind: 'query', title: t('activity.queryTab', { id: r.id }), sessionId: s.session_id, sql: r.query ?? '' }),
  });
  const selectedRows = [...selected].map((id) => byId.get(id)).filter((r): r is ActivityRow => !!r);
  const empty = !groups.blocking.length && !groups.running.length && !groups.idle.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <input
          className="input h-7 min-w-40 flex-1"
          placeholder={t('activity.search')}
          aria-label={t('activity.search')}
          value={filter.search}
          onChange={(e) => setFilter({ ...filter, search: e.target.value })}
        />
        <select className="input h-7 w-auto" aria-label={t('activity.database')} value={filter.database ?? ''} onChange={(e) => setFilter({ ...filter, database: e.target.value || null })}>
          <option value="">{t('activity.allDatabases')}</option>
          {databases.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="input h-7 w-auto" aria-label={t('activity.user')} value={filter.user ?? ''} onChange={(e) => setFilter({ ...filter, user: e.target.value || null })}>
          <option value="">{t('activity.allUsers')}</option>
          {users.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <button className={`icon-btn h-7 w-7 ${paused ? 'text-warn' : ''}`} aria-pressed={paused} aria-label={paused ? t('activity.resume') : t('activity.pause')} title={paused ? t('activity.resume') : t('activity.pause')} onClick={() => setPaused((p) => !p)}>
          <Icon name={paused ? 'play' : 'stop'} size={13} />
        </button>
        <button className="icon-btn h-7 w-7" aria-label={t('common.refresh')} title={t('common.refresh')} onClick={refresh}>
          <Icon name="refresh" size={13} className={data.loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {data.error && <p className="border-b border-border bg-danger/10 px-3 py-1 text-xs text-danger">{data.error}</p>}
      {holding && data.at > 0 && <p className="border-b border-border px-3 py-0.5 text-[0.72rem] text-muted">{t('activity.held')}</p>}
      <div role="grid" aria-label={t('activity.title')} className="min-h-0 flex-1 overflow-auto" onKeyDown={onKey} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {groups.blocking.length > 0 && (
          <section>
            <h3 className="sticky top-0 z-10 bg-danger/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-danger">{t('activity.blocking', { count: groups.blocking.length, formatted: fmtNumber(groups.blocking.length) })}</h3>
            {groups.blocking.map((c) => (
              <div key={c.blocker.id}>
                <Row {...rowProps(c.blocker)} />
                {c.waiters.map((w) => <Row key={w.id} nested {...rowProps(w)} />)}
              </div>
            ))}
          </section>
        )}
        {groups.running.length > 0 && (
          <section>
            <h3 className="sticky top-0 z-10 bg-panel px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted">{t('activity.running', { count: groups.running.length, formatted: fmtNumber(groups.running.length) })}</h3>
            {groups.running.map((r) => <Row key={r.id} {...rowProps(r)} />)}
          </section>
        )}
        {groups.idle.length > 0 && (
          <section>
            <h3 className="sticky top-0 z-10 bg-panel px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted">{t('activity.idle', { count: groups.idle.length, formatted: fmtNumber(groups.idle.length) })}</h3>
            {groups.idle.map((r) => <Row key={r.id} {...rowProps(r)} />)}
          </section>
        )}
        {empty && data.at > 0 && <p className="p-4 text-sm text-muted">{filter.search || filter.database || filter.user ? t('activity.noMatches') : t('activity.nothingRunning')}</p>}
        {groups.idleCount > 0 && (
          <button className="m-3 rounded-full border border-border px-3 py-1 text-xs text-muted hover:bg-hover" onClick={() => setFilter({ ...filter, showIdle: !filter.showIdle })}>
            {filter.showIdle ? t('activity.hideIdle') : t('activity.showIdle', { count: groups.idleCount, formatted: fmtNumber(groups.idleCount) })}
          </button>
        )}
      </div>
      {selectedRows.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border bg-raised px-3 py-2 text-sm">
          <span>{t('activity.selected', { count: selectedRows.length, formatted: fmtNumber(selectedRows.length) })}</span>
          <button className="btn h-7 text-xs" onClick={() => setSelected(new Set())}>{t('activity.clear')}</button>
          <span className="ms-auto" />
          <button className="btn h-7 text-xs" disabled={!!canStop || !actionable(selectedRows, 'query').length} title={canStop ?? undefined} onClick={() => void stop(selectedRows, 'query')}>
            {t('activity.cancelQueries', { count: actionable(selectedRows, 'query').length, formatted: fmtNumber(actionable(selectedRows, 'query').length) })}
          </button>
          <button className="btn btn-danger h-7 text-xs" disabled={!!canStop || !actionable(selectedRows, 'connection').length} title={canStop ?? undefined} onClick={() => void stop(selectedRows, 'connection')}>
            {t('activity.killConnections', { count: actionable(selectedRows, 'connection').length, formatted: fmtNumber(actionable(selectedRows, 'connection').length) })}
          </button>
        </div>
      )}
      {stopReq && <StopDialog req={stopReq} session={s} />}
    </div>
  );
}
