import { api } from './ipc';
import type { ObjectRef } from './types';

/** Column names per table, for autocomplete. */
export type ColumnMap = Record<string, string[]>;

/** Engines without `list_columns` fall back to describing at most this many tables. */
export const FALLBACK_DESCRIBE_LIMIT = 25;

// One load per object list: every query tab of a session reads the same
// `objects[schema]` array from the store, so they share one request, and a
// refresh (a new array) loads once more. Weak keys let old lists be collected.
const cache = new WeakMap<ObjectRef[], Promise<ColumnMap>>();

/**
 * Columns of every table in a schema for autocomplete, in ONE round trip
 * (`list_columns`). Describing tables one by one (6 queries each on MySQL) kept
 * the session's single connection busy for minutes over a VPN, so opening a
 * table queued behind autocomplete.
 */
export function schemaColumns(sessionId: string, schema: string | null, objects: ObjectRef[], deps = { api }): Promise<ColumnMap> {
  let p = cache.get(objects);
  if (!p) {
    p = load(sessionId, schema, objects, deps.api);
    cache.set(objects, p);
  }
  return p;
}

async function load(sessionId: string, schema: string | null, objects: ObjectRef[], a: typeof api): Promise<ColumnMap> {
  try {
    const out: ColumnMap = {};
    for (const c of await a.listColumns(sessionId, schema)) (out[c.table] ??= []).push(c.name);
    return out;
  } catch {
    // Engine without list_columns (e.g. DynamoDB): describe a few tables, one at a time.
    const out: ColumnMap = {};
    for (const o of objects.filter((x) => x.kind === 'table').slice(0, FALLBACK_DESCRIBE_LIMIT)) {
      try {
        out[o.name] = (await a.describeTable(sessionId, { schema: o.schema, table: o.name })).columns.map((c) => c.name);
      } catch {
        /* skip this table */
      }
    }
    return out;
  }
}
