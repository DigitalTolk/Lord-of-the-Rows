import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmDecision } from './confirm';
import { emptyStaged, History, pendingCount, setCell, toggleDelete, type StagedState } from '../lib/changes';
import { fmtNumber } from '../lib/format';
import { api } from '../lib/ipc';
import { applyStaged, hasKey, resultSource, sourceChanges, type ResultSource } from '../lib/resultEdit';
import type { ResultSet, Value } from '../lib/types';
import type { CellEdit } from './DataGrid';
import { errMsg, useApp } from '../store';

/** Stable "no edits" value, so the grid doesn't see a new object on every render. */
const NOTHING_STAGED: StagedState = emptyStaged();

export type ReadOnlyReason = 'connection' | 'noTable' | 'manyTables' | 'noKey' | 'loading' | 'streaming' | 'searching';

/**
 * Staged editing of a query result whose columns come from one table with its primary key
 * in the result. Commits go through the same preview / safety check / apply path as the
 * table view; on success the result rows are updated in place (the query is not re-run).
 */
export function useResultEdit({ sessionId, rs, streaming, searching }: { sessionId?: string; rs?: ResultSet | null; streaming?: boolean; searching: boolean }) {
  const { t } = useTranslation();
  const s = useApp((st) => (sessionId ? st.sessions[sessionId] : undefined));
  const toast = useApp((st) => st.toast);
  // Rows and staged edits belong to one result set: a new run starts clean.
  const [committed, setCommitted] = useState<{ rs: ResultSet; rows: Value[][] } | null>(null);
  const [stagedOf, setStagedOf] = useState<{ rs: ResultSet; staged: StagedState } | null>(null);
  const hist = useRef(new History<StagedState>());
  const rows = rs ? (committed?.rs === rs ? committed.rows : rs.rows) : [];
  const staged = rs && stagedOf?.rs === rs ? stagedOf.staged : NOTHING_STAGED;
  useEffect(() => {
    hist.current.clear();
  }, [rs]);

  const src = useMemo(() => (rs ? resultSource(rs.columns) : 'noTable'), [rs]);
  const srcKey = typeof src === 'object' && s ? `${s.session_id}\u0000${src.target.schema ?? ''}\u0000${src.target.table}` : null;
  const [pk, setPk] = useState<{ key: string; cols: string[] } | null>(null);
  const engineOk = !!s && s.capabilities.sql && s.capabilities.inline_edit && !s.config.read_only;
  useEffect(() => {
    if (!srcKey || !engineOk || typeof src !== 'object' || pk?.key === srcKey) return;
    let live = true;
    api
      .describeTable(s!.session_id, src.target)
      .then((d) => live && setPk({ key: srcKey, cols: d.primary_key ?? [] }))
      .catch(() => live && setPk({ key: srcKey, cols: [] }));
    return () => {
      live = false;
    };
  }, [srcKey, engineOk]); // eslint-disable-line react-hooks/exhaustive-deps
  const keyCols = pk && pk.key === srcKey ? pk.cols : null;

  const reason: ReadOnlyReason | null = !engineOk
    ? 'connection'
    : typeof src !== 'object'
      ? src
      : keyCols === null
        ? 'loading'
        : !hasKey(src, keyCols)
          ? 'noKey'
          : streaming
            ? 'streaming'
            : searching
              ? 'searching'
              : null;
  const source = typeof src === 'object' ? src : null;
  const editable = reason === null;
  const pending = pendingCount(staged);

  const setStaged = (next: StagedState) => rs && setStagedOf({ rs, staged: next });
  const change = (next: StagedState) => {
    hist.current.push(staged);
    setStaged(next);
  };
  const idx = (col: string) => rs?.columns.findIndex((c) => c.name === col) ?? -1;
  const onEdit = (row: number, col: string, v: Value) => change(setCell(staged, row, col, v, rows[row][idx(col)]));
  const onEditMany = (edits: CellEdit[]) => {
    let next = staged;
    for (const e of edits) if (e.value !== undefined && e.row < rows.length) next = setCell(next, e.row, e.col, e.value, rows[e.row][idx(e.col)]);
    change(next);
  };
  const onDeleteRows = (r: number[]) => change(toggleDelete(staged, r.filter((x) => x < rows.length)));

  const changes = () => (rs && source && keyCols ? sourceChanges(staged, rs.columns, rows, source, keyCols) : []);
  const statements = async () => (s && source ? (await api.previewChanges(s.session_id, source.target, changes())).statements : []);
  const busy = useRef(false);
  const commit = async () => {
    if (!s || !rs || !source || busy.current) return;
    busy.current = true;
    try {
      const ch = changes();
      if (!ch.length) return;
      const p = await api.previewChanges(s.session_id, source.target, ch);
      let token: string | null = null;
      // Production / risky edits ask (or are blocked) exactly as in the table view.
      if (p.decision.decision !== 'allow') {
        const c = await confirmDecision(p.decision, { production: s.config.environment === 'production', sqlPreview: p.statements.join(';\n') + ';' });
        if (!c) return;
        token = c.token;
      }
      const r = await api.applyChanges(s.session_id, source.target, ch, token);
      if (!r.committed) {
        toast('error', t('grid.conflict', { count: r.conflicts.length, formatted: fmtNumber(r.conflicts.length) }));
        return;
      }
      setCommitted({ rs, rows: applyStaged(rows, rs.columns, staged) });
      setStagedOf(null);
      hist.current.clear();
      toast('ok', t('grid.committed', { count: r.rows_affected, formatted: fmtNumber(r.rows_affected) }));
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      busy.current = false;
    }
  };
  const discard = () => pending && change(emptyStaged());
  const undo = () => {
    const p = hist.current.undo(staged);
    if (p) setStaged(p);
  };
  const redo = () => {
    const n = hist.current.redo(staged);
    if (n) setStaged(n);
  };

  return { stage: change, rows, staged, editable, reason, source: source as ResultSource | null, readOnlyColumns: source?.readOnly ?? [], pending, onEdit, onEditMany, onDeleteRows, commit, discard, undo, redo, statements };
}
