import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityList } from '../components/Activity';
import { Toolbar } from '../components/ui';
import { useActivity } from '../lib/activityStore';
import { api } from '../lib/ipc';
import { errMsg, useApp, type Tab } from '../store';
import { SimpleTable } from './StructureView';

// `title` is an i18n key suffix under monitor.stats.*
// `heavy` panels scan table metadata (information_schema.tables) and can take seconds on large
// production servers: they load only on request. `sql(all)` scopes to the current database
// unless "All databases" is ticked. MySQL statements carry a MAX_EXECUTION_TIME hint
// (ignored by MariaDB); every monitor query also gets a client-side timeout.
export interface StatQuery { title: string; heavy?: boolean; scoped?: boolean; sql: (all: boolean) => string }
const MY_LIMIT = '/*+ MAX_EXECUTION_TIME(5000) */';
export const STATS: Record<'pg' | 'mysql', StatQuery[]> = {
  pg: [
    { title: 'dbSize', sql: () => "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE NOT datistemplate ORDER BY pg_database_size(datname) DESC" },
    { title: 'largestTables', sql: () => "SELECT schemaname || '.' || relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS total, pg_size_pretty(pg_indexes_size(relid)) AS indexes, n_live_tup AS live_rows, n_dead_tup AS dead_rows, last_autovacuum, last_autoanalyze FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 25" },
    { title: 'indexUsage', sql: () => "SELECT schemaname || '.' || relname AS table, indexrelname AS index, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_stat_user_indexes ORDER BY idx_scan ASC LIMIT 25" },
    { title: 'cacheHit', sql: () => "SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2) AS cache_hit_pct FROM pg_stat_database" },
    { title: 'locks', sql: () => "SELECT l.pid, l.locktype, l.mode, l.granted, c.relname FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation WHERE l.pid <> pg_backend_pid() ORDER BY l.granted, l.pid LIMIT 100" },
    { title: 'replication', sql: () => 'SELECT client_addr, state, sync_state, write_lag, flush_lag, replay_lag FROM pg_stat_replication' },
  ],
  mysql: [
    { title: 'status', sql: () => "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Questions','Slow_queries','Uptime','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads')" },
    { title: 'largestTables', heavy: true, scoped: true, sql: (all) => `SELECT ${MY_LIMIT} table_schema, table_name, table_rows, ROUND(data_length/1024/1024,1) AS data_mb, ROUND(index_length/1024/1024,1) AS index_mb FROM information_schema.tables WHERE ${all ? "table_schema NOT IN ('mysql','sys','performance_schema','information_schema')" : 'table_schema = DATABASE()'} ORDER BY data_length + index_length DESC LIMIT 25` },
    { title: 'dbSize', heavy: true, sql: () => `SELECT ${MY_LIMIT} table_schema AS db, ROUND(SUM(data_length + index_length) / 1024 / 1024, 1) AS size_mb FROM information_schema.tables GROUP BY table_schema ORDER BY size_mb DESC` },
  ],
};
const MONITOR_TIMEOUT_MS = 8000;

export function MonitorView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const [allDbs, setAllDbs] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [stats, setStats] = useState<Record<string, { heads: string[]; rows: string[][] } | string>>({});
  const fam = s ? (['postgres', 'cockroach_db', 'yugabyte_db', 'greenplum'].includes(s.config.engine) ? 'pg' : ['my_sql', 'maria_db', 'percona'].includes(s.config.engine) ? 'mysql' : null) : null;

  const runStat = async (q: StatQuery, all: boolean) => {
    if (!s) return;
    setBusy((x) => ({ ...x, [q.title]: true }));
    let v: { heads: string[]; rows: string[][] } | string;
    try {
      const r = await api.runSql({ session_id: s.session_id, sql: q.sql(all), query_id: crypto.randomUUID(), max_rows: 200, skip_history: true, timeout_ms: MONITOR_TIMEOUT_MS });
      const rs = r.results[0]?.result;
      v = rs ? { heads: rs.columns.map((c) => c.name), rows: rs.rows.map((row) => row.map((x) => (x.t === 'null' ? '' : 'v' in x ? (typeof x.v === 'object' ? JSON.stringify(x.v) : String(x.v)) : ''))) } : t('monitor.noRows');
    } catch (e) {
      v = errMsg(e);
    }
    setStats((st) => ({ ...st, [q.title]: v }));
    setBusy((x) => ({ ...x, [q.title]: false }));
  };
  // Light panels load on open; heavy ones (metadata scans) only on request or once already loaded.
  const loadStats = async () => {
    if (!fam) return;
    for (const q of STATS[fam]) {
      if (!q.heavy || stats[q.title] !== undefined) await runStat(q, allDbs);
    }
  };
  useEffect(() => {
    void loadStats();
  }, [s?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('monitor.title')} — {s.config.name}</span>
        <span className="ms-2 text-xs text-muted">{s.server.version}</span>
        <button className="btn ms-auto" aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => { void useActivity.getState().refresh(s.session_id); void loadStats(); }}>⟳</button>
      </Toolbar>
      {s.capabilities.sessions_monitor ? (
        <div className="flex h-[55%] min-h-48 flex-col border-b border-border">
          <ActivityList session={s} />
        </div>
      ) : (
        <p className="p-2 text-muted">{t('monitor.unsupported')}</p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {fam && STATS[fam].map((q) => {
          const v = stats[q.title];
          return (
            <section key={q.title} className="mb-4">
              <div className="mb-1 flex items-center gap-2">
                <h3 className="font-semibold">{t(`monitor.stats.${q.title}`)}</h3>
                {q.scoped && (
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input type="checkbox" checked={allDbs} onChange={(e) => { setAllDbs(e.target.checked); if (v !== undefined) void runStat(q, e.target.checked); }} />
                    {t('monitor.allDatabases')}
                  </label>
                )}
                {q.heavy && (
                  <button className="btn h-6 py-0 text-xs" disabled={busy[q.title]} onClick={() => void runStat(q, allDbs)}>{v === undefined ? t('monitor.load') : t('common.refresh')}</button>
                )}
                {busy[q.title] && <span className="text-xs text-muted">…</span>}
              </div>
              {v === undefined ? (
                q.heavy && <p className="text-xs text-muted">{t('monitor.heavyHint')}</p>
              ) : typeof v === 'string' ? <p className="text-sm text-muted">{v}</p> : <SimpleTable heads={v.heads} rows={v.rows} />}
            </section>
          );
        })}
      </div>
    </div>
  );
}
