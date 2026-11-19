// What the export dialog asks for, and how it becomes an `export_tables` request: formats,
// options, file names (one per table, from a pattern) and whether everything goes in one file.
import type { ExportFormat, ExportOptions, TableTarget } from './types';

export type ExportKind = 'csv' | 'json' | 'sql' | 'xlsx';

export interface ExportSettings {
  kind: ExportKind;
  // CSV
  header: boolean;
  nullText: string;
  delimiter: ',' | ';' | '\t' | '|';
  quoteAll: boolean;
  crlf: boolean;
  newlinesToSpace: boolean;
  formulaGuard: boolean;
  // JSON
  jsonLines: boolean;
  // SQL
  sqlDrop: boolean;
  sqlStructure: boolean;
  sqlData: boolean;
  rowsPerInsert: number;
  // output
  oneFile: boolean;
  pattern: string;
  gzip: boolean;
  overwrite: boolean;
}

export const DEFAULT_SETTINGS: ExportSettings = {
  kind: 'csv',
  header: true,
  nullText: '',
  delimiter: ',',
  quoteAll: false,
  crlf: false,
  newlinesToSpace: false,
  formulaGuard: true,
  jsonLines: false,
  sqlDrop: false,
  sqlStructure: true,
  sqlData: true,
  rowsPerInsert: 100,
  oneFile: true,
  pattern: '{table}',
  gzip: false,
  overwrite: false,
};

/** Saved settings merged over the defaults (unknown or mistyped values are ignored). */
export function loadSettings(saved: unknown): ExportSettings {
  const out = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    for (const [k, v] of Object.entries(saved)) {
      if (k in out && typeof v === typeof (out as Record<string, unknown>)[k]) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export function formatOf(s: ExportSettings): ExportFormat {
  switch (s.kind) {
    case 'csv':
      return s.delimiter === '\t' ? 'tsv' : 'csv';
    case 'json':
      return s.jsonLines ? 'json_lines' : 'json';
    case 'sql':
      return 'sql_insert';
    case 'xlsx':
      return 'xlsx';
  }
}

export function extensionOf(s: ExportSettings): string {
  const ext = { csv: s.delimiter === '\t' ? 'tsv' : 'csv', json: s.jsonLines ? 'jsonl' : 'json', sql: 'sql', xlsx: 'xlsx' }[s.kind];
  return s.gzip && s.kind !== 'xlsx' ? `${ext}.gz` : ext;
}

/** Formats that can hold several tables in one file. */
export const canShareFile = (s: ExportSettings) => s.kind === 'sql' || s.kind === 'xlsx' || (s.kind === 'json' && s.jsonLines);

/** One file for everything (only when the format can hold several tables, or there is one table). */
export const writesOneFile = (s: ExportSettings, tables: number) => tables === 1 || (s.oneFile && canShareFile(s));

const pad = (n: number) => String(n).padStart(2, '0');

/** A file name from the pattern: {table}, {schema}, {database}, {date}, {time}; unsafe characters become `_`. */
export function fileName(pattern: string, t: TableTarget, database: string, now: Date, ext: string): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const vars: Record<string, string> = { table: t.table, schema: t.schema ?? database, database, date, time };
  const base = (pattern.trim() || '{table}').replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  // eslint-disable-next-line no-control-regex
  const safe = base.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'export';
  return `${safe}.${ext}`;
}

/** Names for a folder export; repeated names get " (2)", " (3)", … */
export function fileNames(s: ExportSettings, tables: TableTarget[], database: string, now: Date): string[] {
  const ext = extensionOf(s);
  const seen = new Map<string, number>();
  return tables.map((t) => {
    const n = fileName(s.pattern, t, database, now, ext);
    const k = n.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    return c === 1 ? n : n.replace(new RegExp(`\\.${ext.replace('.', '\\.')}$`), ` (${c}).${ext}`);
  });
}

export interface ExportTablesRequest {
  export_id: string;
  session_id: string;
  tables: TableTarget[];
  grant: string;
  options: ExportOptions & { delimiter?: string | null; line_break?: string | null; newlines_to_space?: boolean; quote_all?: boolean };
  one_file: boolean;
  file_names: string[];
  gzip: boolean;
  overwrite: boolean;
  filters: unknown[];
  sql: { drop: boolean; structure: boolean; data: boolean };
}

export function buildRequest(s: ExportSettings, a: { exportId: string; sessionId: string; tables: TableTarget[]; grant: string; database: string; now: Date; filters?: unknown[] }): ExportTablesRequest {
  const oneFile = writesOneFile(s, a.tables.length);
  return {
    export_id: a.exportId,
    session_id: a.sessionId,
    tables: a.tables,
    grant: a.grant,
    options: {
      format: formatOf(s),
      header: s.header,
      null_text: s.nullText,
      formula_guard: s.formulaGuard,
      rows_per_insert: s.rowsPerInsert,
      delimiter: s.kind === 'csv' && s.delimiter !== '\t' ? s.delimiter : null,
      line_break: s.crlf ? '\r\n' : '\n',
      newlines_to_space: s.newlinesToSpace,
      quote_all: s.quoteAll,
    },
    one_file: oneFile,
    file_names: oneFile ? [] : fileNames(s, a.tables, a.database, a.now),
    gzip: s.gzip && s.kind !== 'xlsx',
    overwrite: s.overwrite,
    filters: a.tables.length === 1 ? (a.filters ?? []) : [],
    sql: { drop: s.sqlDrop, structure: s.sqlStructure, data: s.sqlData },
  };
}
