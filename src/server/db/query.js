/**
 * Query building blocks shared by every list endpoint.
 *
 * Lists always paginate in SQL and never materialise a whole table (§ 10, § 73).
 * Sorting is restricted to an allow-list so a client cannot inject SQL or sort
 * by an unindexed expression.
 */
import { all, get } from '../db/connection.js';

const SORT_DIRECTIONS = new Set(['asc', 'desc', 'ASC', 'DESC']);

/**
 * @param {object} options
 * @param {Record<string, string>} options.sortable  public sort key → SQL expression
 * @param {string} [options.defaultSort]
 * @param {string} [options.defaultDir]
 * @param {string|number} [options.sort]
 * @param {string} [options.dir]
 */
export function resolveSort(options) {
  const key = String(options.sort ?? options.defaultSort ?? Object.keys(options.sortable)[0]);
  const expression = options.sortable[key] ?? options.sortable[options.defaultSort ?? ''] ?? '1';
  const requestedDir = String(options.dir ?? options.defaultDir ?? 'desc');
  const direction = SORT_DIRECTIONS.has(requestedDir) ? requestedDir.toUpperCase() : 'DESC';
  return { key, expression, direction, sql: `${expression} ${direction}` };
}

/**
 * @param {{ page?: number|string|null, pageSize?: number|string|null }} [options]
 */
export function resolvePaging({ page, pageSize } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(500, Math.max(1, Number(pageSize) || 25));
  return { page: safePage, pageSize: safeSize, offset: (safePage - 1) * safeSize };
}

/**
 * Run a paged query: a count query plus one page of rows.
 * @template T
 * @param {import('bun:sqlite').Database} db
 * @param {{ select: string, from: string, where?: string[], params?: any[], groupBy?: string, orderBy: string, page: number, pageSize: number }} spec
 * @returns {{ rows: T[], total: number, page: number, pageSize: number, pages: number }}
 */
export function pagedQuery(db, spec) {
  const whereSql = spec.where?.length ? `WHERE ${spec.where.join(' AND ')}` : '';
  const groupSql = spec.groupBy ? `GROUP BY ${spec.groupBy}` : '';
  const countSql = spec.groupBy
    ? `SELECT COUNT(*) AS c FROM (SELECT 1 FROM ${spec.from} ${whereSql} ${groupSql})`
    : `SELECT COUNT(*) AS c FROM ${spec.from} ${whereSql}`;
  const total = Number(get(db, countSql, spec.params ?? [])?.c ?? 0);
  const { page, pageSize, offset } = resolvePaging(spec);
  const rows = all(
    db,
    `${spec.select} FROM ${spec.from} ${whereSql} ${groupSql} ORDER BY ${spec.orderBy} LIMIT ? OFFSET ?`,
    [...(spec.params ?? []), pageSize, offset],
  );
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Build `IN (?, ?, ?)` placeholders for an id list. */
export function placeholders(count) {
  return new Array(count).fill('?').join(',');
}

/** Chunk an id list so `IN` clauses stay within SQLite's parameter limits. */
export function chunks(list, size = 400) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Search helper: escape LIKE wildcards and build a pattern.
 * @param {string} term
 */
export function like(term) {
  return `%${String(term ?? '').replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export const LIKE_ESCAPE = "ESCAPE '\\'";

/** Convert a comma separated `ids` list into numbers. */
export function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Simple key/value sort allow-list helper for the UI. */
export function sortOptionsFor(entity) {
  return entity?.sorts ?? null;
}
