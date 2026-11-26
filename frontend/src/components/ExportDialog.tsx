import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { api } from '../lib/ipc';
import { fmtNumber } from '../lib/format';
import { buildRequest, canShareFile, extensionOf, fileName, fileNames, loadSettings, writesOneFile, type ExportKind, type ExportSettings } from '../lib/exportPlan';
import type { ExportProgress, FilterCondition, TableTarget } from '../lib/types';
import { errMsg, useApp, type OpenSession } from '../store';
import { Icon } from './icons';
import { Dialog } from './ui';

/** What the export dialog opens with: the connection, preselected tables, and (from a table tab) its filter. */
export interface ExportRequest {
  sessionId: string;
  tables: TableTarget[];
  filters?: FilterCondition[];
}

export const useExportDialog = create<{ req: ExportRequest | null }>(() => ({ req: null }));
export const openExport = (req: ExportRequest | null) => useExportDialog.setState({ req });

export function ExportHost() {
  const req = useExportDialog((x) => x.req);
  const s = useApp((st) => (req ? st.sessions[req.sessionId] : undefined));
  if (!req || !s) return null;
  return <ExportDialog key={JSON.stringify(req)} s={s} req={req} onClose={() => openExport(null)} />;
}

const keyOf = (t: TableTarget) => `${t.schema ?? ''}\u0000${t.table}`;
/** Saved under `io.` — the backend only accepts settings with known prefixes. */
export const SETTINGS_KEY = 'io.export';

type Run = { rows: number[]; done: boolean[]; result?: { tables: number; rows: number; paths: string[] }; error?: string; cancelled?: boolean };

/**
 * Export tables: choose any tables of the connection (search, per-database checkboxes), a format
 * with its options, and where the files go (one file, or one per table from a name pattern).
 * Runs with per-table progress and can be cancelled. The last settings are remembered.
 */
export function ExportDialog({ s, req, onClose }: { s: OpenSession; req: ExportRequest; onClose: () => void }) {
  const { t } = useTranslation();
  const settingsSaved = useApp((st) => st.settings[SETTINGS_KEY]);
  const [o, setO] = useState<ExportSettings>(() => loadSettings(settingsSaved));
  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) => setO((x) => ({ ...x, [k]: v }));
  const schemas = s.schemas.length ? s.schemas : [''];
  const [selected, setSelected] = useState<TableTarget[]>(req.tables);
  const [open, setOpen] = useState<Set<string>>(() => new Set([...req.tables.map((x) => x.schema ?? ''), s.activeSchema ?? schemas[0]]));
  const [q, setQ] = useState('');
  const [onlyFiltered, setOnlyFiltered] = useState(!!req.filters?.length);
  const [run, setRun] = useState<Run | null>(null);
  const exportId = useRef<string | null>(null);
  const now = useMemo(() => new Date(), []);

  // Tables of each opened database (loaded on demand).
  useEffect(() => {
    for (const sc of open) if (!s.objects[sc]) void useApp.getState().loadObjects(s.session_id, sc || null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const tablesOf = (sc: string): TableTarget[] => (s.objects[sc] ?? []).filter((x) => x.kind === 'table' || x.kind === 'view').map((x) => ({ schema: x.schema ?? (sc || null), table: x.name }));
  const isSel = (x: TableTarget) => selected.some((y) => keyOf(y) === keyOf(x));
  const toggle = (x: TableTarget) => setSelected((cur) => (cur.some((y) => keyOf(y) === keyOf(x)) ? cur.filter((y) => keyOf(y) !== keyOf(x)) : [...cur, x]));
  const toggleSchema = async (sc: string) => {
    if (!s.objects[sc]) await useApp.getState().loadObjects(s.session_id, sc || null);
    const all = (useApp.getState().sessions[s.session_id]?.objects[sc] ?? []).filter((x) => x.kind === 'table' || x.kind === 'view').map((x) => ({ schema: x.schema ?? (sc || null), table: x.name }));
    const allOn = all.length > 0 && all.every(isSel);
    setSelected((cur) => (allOn ? cur.filter((y) => !all.some((a) => keyOf(a) === keyOf(y))) : [...cur, ...all.filter((a) => !cur.some((y) => keyOf(y) === keyOf(a)))]));
    setOpen((x) => new Set([...x, sc]));
  };
  const lq = q.trim().toLowerCase();

  const oneFile = writesOneFile(o, selected.length);
  const database = s.activeSchema ?? s.config.name;
  const preview = selected.length === 0 ? [] : oneFile ? [fileName(o.pattern, selected[0], database, now, extensionOf(o))] : fileNames(o, selected, database, now).slice(0, 3);
  const busy = !!run && !run.result && !run.error && !run.cancelled;

  const start = async () => {
    if (!selected.length) return;
    // Remembering the settings is a convenience: never let it get in the way of the export.
    useApp.getState().setSetting(SETTINGS_KEY, o).catch(() => undefined);
    const ext = extensionOf(o);
    const picked = oneFile ? await api.pickFile(true, preview[0], [ext.split('.').pop()!]) : await api.pickFolder();
    if (!picked) return;
    const id = crypto.randomUUID();
    exportId.current = id;
    setRun({ rows: selected.map(() => 0), done: selected.map(() => false) });
    const onProgress = (p: ExportProgress) =>
      setRun((r) => {
        if (!r) return r;
        const rows = [...r.rows];
        const done = [...r.done];
        rows[p.index] = p.rows;
        if (p.kind === 'table_done') done[p.index] = true;
        return { ...r, rows, done };
      });
    try {
      const request = buildRequest(o, { exportId: id, sessionId: s.session_id, tables: selected, grant: picked.grant, database, now, filters: onlyFiltered ? req.filters : [] });
      const result = await api.exportTables(request, onProgress);
      setRun((r) => (r ? { ...r, result } : r));
      useApp.getState().toast('ok', t('export.done', { rows: fmtNumber(result.rows), tables: fmtNumber(result.tables) }));
    } catch (e) {
      const m = errMsg(e);
      setRun((r) => (r ? { ...r, ...(/cancel/i.test(m) ? { cancelled: true } : { error: m }) } : r));
    }
  };
  const cancel = () => exportId.current && void api.cancelQuery(exportId.current);

  const kinds: [ExportKind, string][] = [['csv', 'CSV'], ['text', t('export.text')], ['json', 'JSON'], ['sql', 'SQL'], ['xlsx', 'Excel']];
  const check = (k: keyof ExportSettings, label: string, hint?: string) => (
    <label className="flex items-start gap-2 py-0.5" title={hint}>
      <input type="checkbox" className="mt-[3px]" checked={o[k] as boolean} onChange={(e) => set(k, e.target.checked as never)} />
      <span>{label}{hint && <span className="block text-xs text-muted">{hint}</span>}</span>
    </label>
  );
  const row = (label: string, control: React.ReactNode) => (
    <label className="grid grid-cols-[9rem_1fr] items-center gap-2 py-0.5">
      <span className="text-muted">{label}</span>
      {control}
    </label>
  );

  const footer = run ? (
    <>
      {busy ? <button className="btn" onClick={cancel}>{t('common.cancel')}</button> : <button className="btn btn-primary" onClick={onClose}>{t('export.close')}</button>}
    </>
  ) : (
    <>
      <span className="me-auto text-sm text-muted" aria-live="polite">{t('export.selected', { n: fmtNumber(selected.length) })}</span>
      <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn btn-primary" disabled={!selected.length || (o.kind === 'sql' && !o.sqlData && !o.sqlStructure && !o.sqlDrop)} onClick={() => void start()}>{oneFile ? t('export.exportFile') : t('export.exportFolder')}</button>
    </>
  );

  return (
    <Dialog title={t('export.title', { name: s.config.name })} onClose={busy ? cancel : onClose} footer={footer} wide>
      {run ? (
        <div className="min-h-[300px]">
          <ul className="max-h-[360px] overflow-auto text-sm" aria-label={t('export.progress')}>
            {selected.map((x, i) => (
              <li key={keyOf(x)} className="flex items-center gap-2 border-b border-border/50 py-1">
                <span aria-hidden className={`w-4 text-center ${run.done[i] ? 'text-ok' : 'text-muted'}`}>{run.done[i] ? '✓' : busy && run.done.indexOf(false) === i ? '…' : ''}</span>
                <span className="truncate font-mono">{x.schema ? `${x.schema}.` : ''}{x.table}</span>
                <span className="ms-auto tabular-nums text-muted">{t('export.rows', { n: fmtNumber(run.rows[i]) })}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-sm" aria-live="polite">
            {run.result && <p className="text-ok">{t('export.done', { rows: fmtNumber(run.result.rows), tables: fmtNumber(run.result.tables) })}<span className="mt-1 block break-all font-mono text-xs text-muted">{run.result.paths.slice(0, 5).join('\n')}</span></p>}
            {run.cancelled && <p className="text-warn">{t('export.cancelled')}</p>}
            {run.error && <p className="text-danger">{run.error}</p>}
          </div>
        </div>
      ) : (
        <div className="grid min-h-[380px] grid-cols-[minmax(220px,1fr)_minmax(300px,1.3fr)] gap-4">
          <div className="flex min-h-0 flex-col rounded border border-border">
            <input className="input m-2 h-7" placeholder={t('export.searchTables')} aria-label={t('export.searchTables')} value={q} onChange={(e) => setQ(e.target.value)} />
            <ul className="max-h-[340px] min-h-0 flex-1 overflow-auto px-1 pb-2 text-sm" aria-label={t('export.tables')}>
              {schemas.map((sc) => {
                const list = tablesOf(sc);
                const shown = lq ? list.filter((x) => x.table.toLowerCase().includes(lq)) : list;
                if (lq && !shown.length && !sc.toLowerCase().includes(lq)) return null;
                const on = list.filter(isSel).length;
                const expanded = open.has(sc) || !!lq;
                return (
                  <li key={sc || '-'}>
                    {sc && (
                      <div className="flex items-center gap-1 py-0.5">
                        <button className="icon-btn h-5 w-5" aria-expanded={expanded} aria-label={sc} onClick={() => setOpen((x) => { const n = new Set(x); if (n.has(sc)) n.delete(sc); else n.add(sc); return n; })}>
                          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
                        </button>
                        <input type="checkbox" aria-label={t('export.allIn', { name: sc })} checked={list.length > 0 && on === list.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < list.length; }} onChange={() => void toggleSchema(sc)} />
                        <span className="truncate font-medium">{sc}</span>
                        {on > 0 && <span className="ms-auto pe-1 text-xs tabular-nums text-muted">{on}</span>}
                      </div>
                    )}
                    {expanded && (
                      <ul className={sc ? 'ps-6' : ''}>
                        {!s.objects[sc] && <li className="py-0.5 text-muted">{t('common.loading')}</li>}
                        {shown.map((x) => (
                          <li key={keyOf(x)}>
                            <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
                              <input type="checkbox" checked={isSel(x)} onChange={() => toggle(x)} />
                              <Icon name="table" size={13} className="shrink-0 text-muted" />
                              <span className="truncate font-mono">{x.table}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex min-h-0 flex-col gap-3 text-sm">
            <div className="seg self-start" role="radiogroup" aria-label={t('export.format')}>
              {kinds.map(([k, label]) => <button key={k} role="radio" aria-checked={o.kind === k} onClick={() => set('kind', k)}>{label}</button>)}
            </div>

            <fieldset className="rounded border border-border p-3">
              <legend className="px-1 text-xs text-muted">{t('export.options')}</legend>
              {o.kind === 'csv' && (
                <>
                  {check('header', t('export.header'))}
                  {row(t('export.delimiter'), (
                    <select className="input h-7" value={o.delimiter} onChange={(e) => set('delimiter', e.target.value as ExportSettings['delimiter'])}>
                      <option value=",">{t('export.comma')} ( , )</option>
                      <option value=";">{t('export.semicolon')} ( ; )</option>
                      <option value={'\t'}>{t('export.tab')}</option>
                      <option value="|">{t('export.pipe')} ( | )</option>
                    </select>
                  ))}
                  {row(t('export.nullAs'), (
                    <select className="input h-7" value={o.nullText === '' ? '' : o.nullText === 'NULL' ? 'NULL' : '\\N'} onChange={(e) => set('nullText', e.target.value)}>
                      <option value="">{t('export.nullEmpty')}</option>
                      <option value="NULL">NULL</option>
                      <option value="\N">\N</option>
                    </select>
                  ))}
                  {row(t('export.quote'), (
                    <select className="input h-7" value={o.quoteAll ? 'all' : 'needed'} onChange={(e) => set('quoteAll', e.target.value === 'all')}>
                      <option value="needed">{t('export.quoteNeeded')}</option>
                      <option value="all">{t('export.quoteAll')}</option>
                    </select>
                  ))}
                  {row(t('export.lineEnding'), (
                    <select className="input h-7" value={o.crlf ? 'crlf' : 'lf'} onChange={(e) => set('crlf', e.target.value === 'crlf')}>
                      <option value="lf">LF (\n) — macOS, Linux</option>
                      <option value="crlf">CRLF (\r\n) — Windows, Excel</option>
                    </select>
                  ))}
                  {check('newlinesToSpace', t('export.newlinesToSpace'))}
                  {check('formulaGuard', t('export.formulaGuard'), t('export.formulaGuardHint'))}
                </>
              )}
              {o.kind === 'json' && (
                <div className="seg" role="radiogroup" aria-label={t('export.jsonShape')}>
                  <button role="radio" aria-checked={!o.jsonLines} onClick={() => set('jsonLines', false)}>{t('export.jsonArray')}</button>
                  <button role="radio" aria-checked={o.jsonLines} onClick={() => set('jsonLines', true)}>{t('export.jsonLines')}</button>
                </div>
              )}
              {o.kind === 'sql' && (
                <>
                  {check('sqlDrop', t('export.sqlDrop'))}
                  {check('sqlStructure', t('export.sqlStructure'))}
                  {check('sqlData', t('export.sqlData'))}
                  {o.sqlData && row(t('export.rowsPerInsert'), (
                    <select className="input h-7" value={o.rowsPerInsert} onChange={(e) => set('rowsPerInsert', Number(e.target.value))}>
                      {[1, 50, 100, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ))}
                </>
              )}
              {o.kind === 'text' && <p className="text-sm text-muted">{t('export.textHint')}</p>}
              {o.kind === 'xlsx' && (
                <>
                  {check('header', t('export.header'))}
                  {check('formulaGuard', t('export.formulaGuard'), t('export.formulaGuardHint'))}
                </>
              )}
            </fieldset>

            <fieldset className="rounded border border-border p-3">
              <legend className="px-1 text-xs text-muted">{t('export.output')}</legend>
              {req.filters && req.filters.length > 0 && selected.length === 1 && (
                <label className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={onlyFiltered} onChange={(e) => setOnlyFiltered(e.target.checked)} />{t('export.onlyFiltered', { n: req.filters.length })}</label>
              )}
              {selected.length > 1 && canShareFile(o) && (
                <div className="seg mb-1" role="radiogroup" aria-label={t('export.output')}>
                  <button role="radio" aria-checked={o.oneFile} onClick={() => set('oneFile', true)}>{o.kind === 'xlsx' ? t('export.oneWorkbook') : t('export.oneFile')}</button>
                  <button role="radio" aria-checked={!o.oneFile} onClick={() => set('oneFile', false)}>{t('export.filePerTable')}</button>
                </div>
              )}
              {row(t('export.fileName'), (
                <input className="input h-7 font-mono" value={o.pattern} onChange={(e) => set('pattern', e.target.value)} aria-describedby="export-tokens" />
              ))}
              <p id="export-tokens" className="text-xs text-muted">{t('export.tokens')}</p>
              {preview.length > 0 && (
                <p className="mt-1 break-all font-mono text-xs" aria-label={t('export.preview')}>
                  {preview.join(', ')}{!oneFile && selected.length > preview.length ? ` … (+${selected.length - preview.length})` : ''}
                </p>
              )}
              {o.kind !== 'xlsx' && check('gzip', t('export.gzip'))}
              {!oneFile && check('overwrite', t('export.overwrite'))}
            </fieldset>
          </div>
        </div>
      )}
    </Dialog>
  );
}
