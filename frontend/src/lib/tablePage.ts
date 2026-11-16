import { api } from './ipc';
import type { Engine, FilterCondition, ResultSet, SortDir, TableDescription, TableTarget } from './types';

/**
 * InnoDB (MySQL / MariaDB / Percona) stores rows in primary-key order, so an
 * unordered read already returns them in key order.
 */
const CLUSTERED_BY_PK: readonly Engine[] = ['my_sql', 'maria_db', 'percona'];

export interface TablePageRequest {
  sessionId: string;
  engine: Engine;
  target: TableTarget;
  /** The table description from an earlier load, if any. */
  desc: TableDescription | null;
  sort: [string, SortDir][];
  filters: FilterCondition[];
  offset: number;
  limit: number;
}

export interface TablePageSteps {
  /** Rows to show (called once, or twice when the first read gets put in key order). */
  onRows(rs: ResultSet): void;
  /** The description, once loaded (only when `desc` was not already known). */
  onDesc(d: TableDescription | null): void;
  /** False once a newer load started: its results must be dropped. */
  current(): boolean;
}

/**
 * Loads one page of a table the way DataGrip / TablePlus do: rows first, structure after.
 *
 * The first open reads rows straight away, without waiting for the description
 * (several catalog queries, slow over a VPN), then loads the description. Once the
 * primary key is known, pages are ordered by it so paging stays stable; the first
 * page is re-read in key order unless the engine already returns that order.
 */
export async function loadTablePage(req: TablePageRequest, steps: TablePageSteps, deps = { api }): Promise<TableDescription | null> {
  const a = deps.api;
  const unordered = req.engine === 'dynamo_db'; // Scan: no server-side ordering
  const keyOrder = (d: TableDescription | null): [string, SortDir][] => (unordered ? [] : (d?.primary_key ?? []).map((c) => [c, 'asc']));
  const order = req.sort.length && !unordered ? req.sort : keyOrder(req.desc);
  const page = (order_by: [string, SortDir][]) => a.fetchTable(req.sessionId, req.target, { offset: req.offset, limit: req.limit, order_by, filters: req.filters });

  const rs = await page(order);
  if (!steps.current()) return req.desc;
  steps.onRows(rs);
  if (req.desc) return req.desc;

  const d = await a.describeTable(req.sessionId, req.target).catch(() => null);
  if (!steps.current()) return d;
  steps.onDesc(d);
  const key = keyOrder(d);
  if (!req.sort.length && key.length && !CLUSTERED_BY_PK.includes(req.engine)) {
    const ordered = await page(key).catch(() => null);
    if (ordered && steps.current()) steps.onRows(ordered);
  }
  return d;
}
