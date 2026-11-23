import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { exporters, usePlugins } from '../lib/plugins';
import type { ColumnMeta, ExportFormat, StatementResult, Value } from '../lib/types';
import { displayValue } from '../lib/value';
import { fmtNumber } from '../lib/format';
import { errMsg, useApp } from '../store';
import { DataGrid, type GridHandle } from './DataGrid';
import { Icon } from './icons';
import { SqlPopover } from './SqlPopover';
import { useResultEdit } from './useResultEdit';
import { displayCombo } from '../lib/keys';

import Chart from './Chart';

type Mode = 'grid' | 'json' | 'text' | 'record' | 'chart';

export async function copyAs(columns: ColumnMeta[], rows: Value[][], format: ExportFormat, table?: string) {
  const text = await api.copyRows(columns, rows, { format, header: true, formula_guard: format === 'csv' || format === 'tsv', table: table ? { table } : null });
  await navigator.clipboard.writeText(text);
}

/**
 * `runId` identifies a run: the selected result set resets when it changes or a
 * new result set starts, not on every streamed batch. Without it, every new
 * `results` array counts as a new run.
 */
export function Results({ results, messages, runId, sessionId }: { results: StatementResult[]; messages: string[]; runId?: string; sessionId?: string }) {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const withRows = results.filter((r) => r.result);
  // Show the last result set by default (what you see after "Run all"); reset on each new run.
  const [idx, setIdx] = useState(Math.max(0, withRows.length - 1));
  const resetKey = runId ?? results;
  useEffect(() => {
    setIdx(Math.max(0, withRows.length - 1));
  }, [resetKey, withRows.length]);
  const [mode, setMode] = useState<Mode>('grid');
  const [search, setSearch] = useState('');
  const [recordRow, setRecordRow] = useState(0);
  const current = withRows[Math.min(idx, withRows.length - 1)];
  const rs = current?.result;
  const grid = useRef<GridHandle>(null);
  const edit = useResultEdit({ sessionId, rs, streaming: current?.streaming, searching: !!search });
  const [preview, setPreview] = useState<{ sql: string; loading: boolean; error?: string } | null>(null);
  const closePreview = () => setPreview(null);
  const openPreview = async () => {
    if (preview) return setPreview(null);
    setPreview({ sql: '', loading: true });
    try {
      setPreview({ sql: (await edit.statements()).map((x) => x + ';').join('\n'), loading: false });
    } catch (e) {
      setPreview({ sql: '', loading: false, error: errMsg(e) });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const inField = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (k === 's' && edit.pending) {
      e.preventDefault();
      void edit.commit();
    } else if (k === 'z' && !inField) {
      e.preventDefault();
      if (e.shiftKey) edit.redo();
      else edit.undo();
    }
  };

  const filteredRows = useMemo(() => {
    if (!rs || !search) return edit.rows;
    const q = search.toLowerCase();
    return edit.rows.filter((r) => r.some((v) => displayValue(v).toLowerCase().includes(q)));
  }, [rs, search, edit.rows]);

  const copy = async (rowsIdx: number[], cols: string[], format: ExportFormat = 'tsv') => {
    if (!rs) return;
    const ci = cols.length ? cols.map((c) => rs.columns.findIndex((x) => x.name === c)) : rs.columns.map((_, i) => i);
    const rows = (rowsIdx.length ? rowsIdx.map((r) => filteredRows[r]) : filteredRows).map((r) => ci.map((i) => r[i]));
    try {
      await copyAs(ci.map((i) => rs.columns[i]), rows, format);
      toast('info', t('results.copied', { count: rows.length, formatted: fmtNumber(rows.length) }));
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const pluginExporters = exporters(usePlugins((x) => x.plugins));
  // Rows are passed explicitly by the user's action; the plugin never queries the database.
  const exportViaPlugin = async (id: string) => {
    const p = pluginExporters.find((x) => x.id === id);
    if (!rs || !p?.manifest.export) return;
    try {
      const f = await api.pickFile(true, `results.${p.manifest.export.extension}`, [p.manifest.export.extension]);
      if (!f) return;
      const r = await api.pluginExport(id, f.grant, rs.columns, filteredRows);
      toast('ok', t('results.exportedWithPlugin', { count: r.rows, formatted: fmtNumber(r.rows), name: p.manifest.name }));
    } catch (e) {
      toast('error', errMsg(e));
      void usePlugins.getState().load();
    }
  };

  const [tab, setTab] = useState<'results' | 'messages'>('results');
  const allMessages = [
    ...results.map((r) => `#${r.statement_index + 1} ${r.sql_excerpt.slice(0, 80)} — ${r.rows_affected != null ? t('query.rowsAffected', { count: r.rows_affected, formatted: fmtNumber(r.rows_affected) }) : r.result ? t('query.rowsReturned', { count: r.result.rows.length, formatted: fmtNumber(r.result.rows.length) }) : t('common.ok')} (${t('query.duration', { ms: r.duration_ms })})`),
    ...results.flatMap((r) => r.notices),
    ...messages,
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-[32px] shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
        {/* One tab per result set (several statements → Result 1, Result 2, …), then Messages. */}
        <div role="tablist" aria-label={t('results.title')} className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto">
          {(withRows.length ? withRows : [null]).map((r, i) => {
            const on = tab === 'results' && (withRows.length === 0 || i === Math.min(idx, withRows.length - 1));
            const label = withRows.length > 1 ? t('results.resultN', { n: i + 1 }) : t('results.title');
            return (
              <button
                key={i}
                role="tab"
                aria-selected={on}
                title={r ? `${t('query.statement', { n: r.statement_index + 1 })}: ${r.sql_excerpt}` : undefined}
                className={`btn btn-ghost shrink-0 gap-1 ${on ? 'font-semibold' : ''}`}
                onClick={() => {
                  setIdx(i);
                  setTab('results');
                }}
              >
                {label}
                {withRows.length > 1 && r?.result && <span className="text-xs font-normal tabular-nums text-muted">{fmtNumber(r.result.rows.length)}</span>}
              </button>
            );
          })}
          <button role="tab" aria-selected={tab === 'messages'} className={`btn btn-ghost shrink-0 ${tab === 'messages' ? 'font-semibold' : ''}`} onClick={() => setTab('messages')}>{t('query.messages')} ({allMessages.length})</button>
        </div>
        {tab === 'results' && rs && (
          <>
            <div className="seg ms-2" role="radiogroup" aria-label={t('results.view')}>
              {(['grid', 'json', 'text', 'record', 'chart'] as Mode[]).map((m) => (
                <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>{t(`query.${m}`)}</button>
              ))}
            </div>
            <input className="input ms-2 h-6 w-48" placeholder={t('grid.searchResults')} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('grid.searchResults')} />
            <select className="input h-6 w-auto py-0" aria-label={t('grid.copyAs')} value="" onChange={(e) => e.target.value && copy([], [], e.target.value as ExportFormat)}>
              <option value="">{t('grid.copyAs')}…</option>
              <option value="csv">CSV</option><option value="tsv">TSV</option><option value="json">JSON</option><option value="sql_insert">SQL INSERT</option><option value="markdown">Markdown</option>
            </select>
            {pluginExporters.length > 0 && (
              <select className="input h-6 w-auto py-0" aria-label={t('results.exportWithPlugin')} value="" onChange={(e) => e.target.value && exportViaPlugin(e.target.value)}>
                <option value="">{t('results.exportWithPluginEllipsis')}</option>
                {pluginExporters.map((p) => <option key={p.id} value={p.id}>{p.manifest.export?.label} ({p.manifest.name})</option>)}
              </select>
            )}
            {mode === 'grid' && (
              <>
                <button className="icon-btn" title={`${t('gridTools.jumpTitle')} (${displayCombo('Mod+J')})`} aria-label={t('gridTools.jumpTitle')} onClick={() => grid.current?.openJump()}><Icon name="search" size={15} /></button>
                <button className="icon-btn" title={t('gridTools.columnsTitle')} aria-label={t('gridTools.columnsTitle')} onClick={() => grid.current?.openColumns()}><Icon name="columns" size={15} /></button>
              </>
            )}
            {sessionId && edit.reason !== 'connection' && edit.reason !== 'loading' && (
              <span
                className={`ms-1 flex shrink-0 items-center gap-1 rounded px-1.5 text-xs ${edit.editable ? 'text-ok' : 'text-muted'}`}
                title={edit.editable ? t('resultEdit.editableHint', { table: edit.source?.target.table }) : t(`resultEdit.why.${edit.reason}`)}
              >
                <Icon name={edit.editable ? 'edit' : 'lock'} size={13} />
                {edit.editable ? t('resultEdit.editable', { table: edit.source?.target.table }) : t('resultEdit.readOnly')}
              </span>
            )}
            <span className="ms-auto text-xs text-muted" aria-live="polite">
              {current.streaming ? (
                <span>{t('query.loadingRows', { count: rs.rows.length, formatted: fmtNumber(rs.rows.length) })}{search ? ` · ${t('query.rowsReturned', { count: filteredRows.length, formatted: fmtNumber(filteredRows.length) })}` : ''}</span>
              ) : (
                <>{t('query.rowsReturned', { count: filteredRows.length, formatted: fmtNumber(filteredRows.length) })} · {t('query.duration', { ms: current.duration_ms })}</>
              )}
              {rs.truncated && <span className="ms-2 text-warn">{t('query.truncated', { count: rs.rows.length, formatted: fmtNumber(rs.rows.length) })}</span>}
            </span>
          </>
        )}
      </div>
      {tab === 'results' && edit.pending > 0 && (
        <div role="group" aria-label={t('tableWs.pendingTitle')} className="flex h-[32px] shrink-0 items-center gap-1 border-b border-border bg-warn/10 px-2 text-sm">
          <span className="font-medium text-warn" aria-live="polite">{t('grid.pending', { count: edit.pending, formatted: fmtNumber(edit.pending) })}</span>
          <span className="text-muted">· {edit.source?.target.table}</span>
          <div className="ms-auto flex items-center gap-1">
            <button className="btn h-6" onClick={edit.discard}>{t('common.discard')}</button>
            <div className="relative">
              <button className="btn h-6" aria-expanded={!!preview} onClick={() => void openPreview()}>{t('tableWs.pendingPreview')}</button>
              {preview && (
                <SqlPopover
                  title={t('tableWs.pendingTitle')}
                  sql={preview.sql}
                  loading={preview.loading}
                  error={preview.error}
                  align="right"
                  onClose={closePreview}
                  actions={<button className="btn btn-primary h-7" disabled={!preview.sql} onClick={() => { setPreview(null); void edit.commit(); }}>{t('common.commit')}</button>}
                />
              )}
            </div>
            <button className="btn btn-primary h-6" title={`${t('tableWs.pendingCommit')} (${displayCombo('Mod+S')})`} onClick={() => { setPreview(null); void edit.commit(); }}>{t('common.commit')}</button>
          </div>
        </div>
      )}
      {tab === 'messages' ? (
        <pre dir="ltr" className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs" aria-live="polite">{allMessages.join('\n')}</pre>
      ) : !rs ? (
        <div className="p-4 text-muted">{results.length ? allMessages.slice(0, 5).join('\n') : t('query.noResults')}</div>
      ) : mode === 'grid' ? (
        <DataGrid
          gridRef={grid}
          columns={rs.columns}
          rows={filteredRows}
          staged={search ? undefined : edit.staged}
          editable={edit.editable}
          readOnlyColumns={edit.readOnlyColumns}
          onEdit={edit.onEdit}
          onEditMany={edit.onEditMany}
          onDeleteRows={edit.onDeleteRows}
          onSelectRows={(r) => r.length && setRecordRow(r[0])}
          ariaLabel={t('results.gridLabel')}
        />
      ) : mode === 'json' ? (
        <pre dir="ltr" className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">
          {JSON.stringify(filteredRows.slice(0, 5000).map((r) => Object.fromEntries(rs.columns.map((c, i) => [c.name, r[i].t === 'null' ? null : displayValue(r[i])]))), null, 2)}
        </pre>
      ) : mode === 'text' ? (
        <pre dir="ltr" className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">{textTable(rs.columns, filteredRows.slice(0, 5000))}</pre>
      ) : mode === 'record' ? (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="mb-2 flex items-center gap-2">
            <button className="btn" aria-label={t('results.prevRecord')} title={t('results.prevRecord')} disabled={recordRow <= 0} onClick={() => setRecordRow((r) => r - 1)}><span aria-hidden className="rtl:rotate-180">◀</span></button>
            <span>{t('results.recordOf', { n: recordRow + 1, total: filteredRows.length })}</span>
            <button className="btn" aria-label={t('results.nextRecord')} title={t('results.nextRecord')} disabled={recordRow >= filteredRows.length - 1} onClick={() => setRecordRow((r) => r + 1)}><span aria-hidden className="rtl:rotate-180">▶</span></button>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {rs.columns.map((c, i) => (
                <tr key={i} className="border-b border-border">
                  <th scope="row" className="w-1/4 px-2 py-1 text-start align-top text-muted">{c.name}</th>
                  <td dir="ltr" className="whitespace-pre-wrap break-all px-2 py-1 text-start font-mono">{filteredRows[recordRow] ? displayValue(filteredRows[recordRow][i]) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Chart columns={rs.columns} rows={filteredRows} />
      )}
    </div>
  );
}

function textTable(cols: ColumnMeta[], rows: Value[][]): string {
  const cells = rows.map((r) => r.map((v) => displayValue(v).replace(/\n/g, '\\n')));
  const w = cols.map((c, i) => Math.min(60, Math.max(c.name.length, ...cells.map((r) => r[i].length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, 60).padEnd(w[i])).join(' | ');
  return [line(cols.map((c) => c.name)), w.map((n) => '-'.repeat(n)).join('-+-'), ...cells.map(line)].join('\n');
}
