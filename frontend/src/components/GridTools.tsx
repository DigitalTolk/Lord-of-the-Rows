import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtNumber } from '../lib/format';
import { Icon } from './icons';

export interface ToolColumn {
  name: string;
  type: string;
  hidden: boolean;
}

/** Closes on Escape or a click outside `ref`. */
function useDismiss(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const h = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(h);
      window.removeEventListener('mousedown', onDown);
    };
  }, [ref, onClose]);
}

type JumpItem = { kind: 'column'; col: ToolColumn } | { kind: 'row'; n: number } | { kind: 'value'; q: string };

/** What a jump query offers: a row number, the matching columns (best first), then a value search. */
export function jumpItems(q: string, columns: ToolColumn[], rowCount: number): JumpItem[] {
  const s = q.trim();
  const out: JumpItem[] = [];
  if (/^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= rowCount) out.push({ kind: 'row', n: Number(s) });
  const lc = s.toLowerCase();
  const rank = (n: string) => (n.toLowerCase() === lc ? 0 : n.toLowerCase().startsWith(lc) ? 1 : 2);
  const cols = lc ? columns.filter((c) => c.name.toLowerCase().includes(lc)).sort((a, b) => rank(a.name) - rank(b.name)) : columns;
  out.push(...cols.map((col) => ({ kind: 'column' as const, col })));
  if (s) out.push({ kind: 'value', q: s });
  return out;
}

/**
 * "Jump to": type a column name (hidden ones too), a row number, or a value to find in the
 * loaded rows. Enter on "Find" again moves to the next match.
 */
export function JumpPalette({ columns, rowCount, onColumn, onRow, onFind, onClose }: {
  columns: ToolColumn[];
  rowCount: number;
  onColumn: (name: string) => void;
  onRow: (n: number) => void;
  /** Selects the next cell containing `q`; false when nothing matches. */
  onFind: (q: string) => boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [notFound, setNotFound] = useState(false);
  useDismiss(ref, onClose);
  const items = useMemo(() => jumpItems(q, columns, rowCount), [q, columns, rowCount]);
  const cur = Math.min(active, items.length - 1);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${cur}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [cur]);

  const choose = (it: JumpItem | undefined) => {
    if (!it) return;
    if (it.kind === 'column') onColumn(it.col.name);
    else if (it.kind === 'row') onRow(it.n);
    else {
      setNotFound(!onFind(it.q));
      return; // stays open: Enter finds the next match
    }
    onClose();
  };

  return (
    <div ref={ref} role="dialog" aria-label={t('gridTools.jumpTitle')} className="absolute left-1/2 top-8 z-40 w-[min(460px,calc(100%-24px))] -translate-x-1/2 rounded-lg border border-border bg-raised font-sans shadow-xl">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Icon name="search" size={15} className="text-muted" />
        <input
          autoFocus
          className="input h-7 flex-1"
          role="combobox"
          aria-expanded
          aria-controls="grid-jump-list"
          aria-activedescendant={items.length ? `grid-jump-${cur}` : undefined}
          aria-label={t('gridTools.jumpTitle')}
          placeholder={t('gridTools.jumpPlaceholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setNotFound(false);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(items.length - 1, cur + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, cur - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(items[cur]); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
      </div>
      <div className="px-3 pt-2 text-[0.8rem] text-muted">{t('gridTools.columnsCount', { n: fmtNumber(columns.length) })}</div>
      <ul id="grid-jump-list" ref={list} role="listbox" className="max-h-72 overflow-auto p-1">
        {items.map((it, i) => (
          <li
            key={it.kind === 'column' ? `c-${it.col.name}` : it.kind}
            id={`grid-jump-${i}`}
            data-i={i}
            role="option"
            aria-selected={i === cur}
            className={`flex cursor-default items-center gap-2 rounded px-2 py-1 text-sm ${i === cur ? 'bg-accent-solid text-on-solid' : 'hover:bg-hover'}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(it)}
          >
            {it.kind === 'column' ? (
              <>
                <Icon name={it.col.hidden ? 'eyeOff' : 'table'} size={14} className="shrink-0 opacity-70" />
                <span className="truncate font-mono">{it.col.name}</span>
                <span className={`ms-auto shrink-0 text-xs ${i === cur ? '' : 'text-muted'}`}>{it.col.hidden ? t('gridTools.hidden') : it.col.type}</span>
              </>
            ) : it.kind === 'row' ? (
              <span>{t('gridTools.goToRow', { n: fmtNumber(it.n) })}</span>
            ) : (
              <>
                <Icon name="search" size={14} className="shrink-0 opacity-70" />
                <span className="truncate">{t('gridTools.findValue', { q: it.q })}</span>
                {notFound && i === cur && <span className="ms-auto shrink-0 text-xs">{t('gridTools.noMatch')}</span>}
              </>
            )}
          </li>
        ))}
        {!items.length && <li className="px-2 py-1 text-sm text-muted">{t('gridTools.noColumns')}</li>}
      </ul>
    </div>
  );
}

/**
 * Choose which columns the grid shows: the shown columns as chips (in order), "Add a column"
 * for hidden ones. Clear + Apply shows every column again.
 */
export function ColumnsPicker({ columns, onApply, onClose }: {
  columns: ToolColumn[];
  /** The columns to show; empty means all. */
  onApply: (shown: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const allShown = columns.every((c) => !c.hidden);
  // While every column is shown the list starts empty (= all), like a fresh filter.
  const [shown, setShown] = useState<string[]>(allShown ? [] : columns.filter((c) => !c.hidden).map((c) => c.name));
  useDismiss(ref, onClose);
  const addable = columns.filter((c) => !shown.includes(c.name));
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('gridTools.columnsTitle')}
      className="absolute right-3 top-8 z-40 w-[min(420px,calc(100%-24px))] rounded-lg border border-border bg-raised p-2 font-sans shadow-xl"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <select
        autoFocus
        className="input h-7 w-full"
        aria-label={t('gridTools.addColumn')}
        value=""
        onChange={(e) => e.target.value && setShown([...shown, e.target.value])}
      >
        <option value="">{t('gridTools.addColumn')}</option>
        {addable.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
      <ul aria-label={t('gridTools.shownColumns')} className="mt-2 flex min-h-24 flex-wrap content-start gap-1.5 rounded border border-border bg-bg p-2">
        {shown.map((n) => (
          <li key={n} className="flex items-center gap-1 rounded bg-accent-solid py-0.5 pe-0.5 ps-2 font-mono text-sm text-on-solid">
            {n}
            <button className="rounded px-1 leading-none hover:bg-on-solid/20" aria-label={t('gridTools.removeColumn', { name: n })} onClick={() => setShown(shown.filter((x) => x !== n))}>×</button>
          </li>
        ))}
        {!shown.length && <li className="text-sm text-muted">{t('gridTools.allColumns')}</li>}
      </ul>
      <div className="mt-2 flex justify-between">
        <button className="btn h-7" onClick={() => setShown([])} disabled={!shown.length}>{t('gridTools.clear')}</button>
        <button className="btn btn-primary h-7" onClick={() => { onApply(shown); onClose(); }}>{t('gridTools.apply')}</button>
      </div>
    </div>
  );
}
