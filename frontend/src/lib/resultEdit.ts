// Editing a query result in place. Allowed only when every column that comes from a table comes
// from the same one, and that table's primary key is in the result: each staged edit then becomes
// an UPDATE/DELETE by key (with the original values checked, like the table view).
import { buildChanges, type StagedState } from './changes';
import type { ColumnMeta, RowChange, TableTarget, Value } from './types';

export interface ResultSource {
  target: TableTarget;
  /** result column name → column in the source table */
  sourceOf: Record<string, string>;
  /** result columns that can't be edited (expressions, other tables, repeated names) */
  readOnly: string[];
}

export type NotEditable = 'noTable' | 'manyTables';

/** The one table a result's columns come from, or why there isn't one. */
export function resultSource(columns: ColumnMeta[]): ResultSource | NotEditable {
  const fromTable = columns.filter((c) => c.table && c.column);
  const tables = new Set(fromTable.map((c) => `${c.schema ?? ''}\u0000${c.table}`));
  if (tables.size === 0) return 'noTable';
  if (tables.size > 1) return 'manyTables';
  const names = new Map<string, number>();
  for (const c of columns) names.set(c.name, (names.get(c.name) ?? 0) + 1);
  const sourceOf: Record<string, string> = {};
  const readOnly: string[] = [];
  for (const c of columns) {
    // Two result columns with one name can't be told apart when staging an edit.
    if (c.table && c.column && names.get(c.name) === 1) sourceOf[c.name] = c.column;
    else readOnly.push(c.name);
  }
  const first = fromTable[0];
  return { target: { schema: first.schema ?? null, table: first.table! }, sourceOf, readOnly };
}

/** True when every primary-key column of the source table is in the result. */
export function hasKey(src: ResultSource, primaryKey: string[]): boolean {
  const have = new Set(Object.values(src.sourceOf));
  return primaryKey.length > 0 && primaryKey.every((k) => have.has(k));
}

/** Staged result edits as changes against the source table (column names translated). */
export function sourceChanges(staged: StagedState, columns: ColumnMeta[], rows: Value[][], src: ResultSource, primaryKey: string[]): RowChange[] {
  const projected = columns.map((c, i) => ({ ...c, name: src.sourceOf[c.name] ?? `\u0000expr${i}` }));
  const edits: StagedState['edits'] = {};
  for (const [r, cols] of Object.entries(staged.edits)) {
    edits[Number(r)] = Object.fromEntries(Object.entries(cols).filter(([c]) => src.sourceOf[c]).map(([c, v]) => [src.sourceOf[c], v]));
  }
  return buildChanges({ edits, deleted: staged.deleted, inserted: [] }, projected, rows, primaryKey);
}

/** The result rows after a successful commit: edits applied, deleted rows removed. */
export function applyStaged(rows: Value[][], columns: ColumnMeta[], staged: StagedState): Value[][] {
  const del = new Set(staged.deleted);
  return rows.flatMap((row, r) => {
    if (del.has(r)) return [];
    const e = staged.edits[r];
    return [e ? row.map((v, i) => e[columns[i].name] ?? v) : row];
  });
}
