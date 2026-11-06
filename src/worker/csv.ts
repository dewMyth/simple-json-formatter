import { isLosslessNumber } from 'lossless-json';
import type { CsvOptions } from '@shared/types';
import { CSV_MAX_COLUMNS_WARN } from '@shared/constants';
import {
  DEFAULT_FLATTEN_OPTIONS,
  explodeRecord,
  explodedRowCount,
  flattenRecord,
  isPrimitive,
  type FlattenContext,
} from './flatten';

export const DEFAULT_CSV_OPTIONS: CsvOptions = {
  ...DEFAULT_FLATTEN_OPTIONS,
  sourceNode: 0,
  delimiter: ',',
  quoteAll: false,
  header: true,
  bom: false,
  eol: '\n',
  nullAs: 'empty',
  boolCase: 'lower',
  injectionProtection: true,
};

/** The rows a source value turns into: an array's items, or a single object/primitive as one row. */
export function getRecords(source: unknown): unknown[] {
  return Array.isArray(source) ? source : [source];
}

export function formatPrimitive(v: unknown, opts: Pick<CsvOptions, 'nullAs' | 'boolCase'>): string {
  if (v === null || v === undefined) return opts.nullAs === 'null' ? 'null' : '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean')
    return opts.boolCase === 'upper' ? (v ? 'TRUE' : 'FALSE') : v ? 'true' : 'false';
  // big numbers are written as their exact original text
  if (isLosslessNumber(v)) return v.value;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v);
}

export function makeContext(opts: CsvOptions): FlattenContext {
  return { opts, fmt: (v) => formatPrimitive(v, opts) };
}

/** Iterates rows, applying 'explode' when configured. */
export function* iterRows(records: unknown[], opts: CsvOptions): Generator<unknown> {
  const seg = opts.explodePath && opts.explodePath.length ? opts.explodePath : null;
  for (const r of records) {
    if (seg) yield* explodeRecord(r, seg);
    else yield r;
  }
}

export function countRows(records: unknown[], opts: CsvOptions): number {
  const seg = opts.explodePath && opts.explodePath.length ? opts.explodePath : null;
  if (!seg) return records.length;
  let n = 0;
  for (const r of records) n += isPrimitive(r) ? 1 : explodedRowCount(r, seg);
  return n;
}

/**
 * Pass 1: the ordered union of flattened column names, in order of first appearance.
 * A generator that yields the number of rows processed every `every` rows, returning the columns.
 */
export function* columnsIter(
  records: unknown[],
  opts: CsvOptions,
  every = 1000,
): Generator<number, string[]> {
  const ctx = makeContext(opts);
  const seen = new Set<string>();
  let i = 0;
  for (const row of iterRows(records, opts)) {
    for (const k of flattenRecord(row, ctx).keys()) seen.add(k);
    if (++i % every === 0) yield i;
  }
  return [...seen];
}

export function computeColumns(records: unknown[], opts: CsvOptions): string[] {
  const it = columnsIter(records, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

export function columnWarnings(columns: number): string[] {
  return columns > CSV_MAX_COLUMNS_WARN
    ? [
        `This CSV would have ${columns.toLocaleString('en-US')} columns. Consider switching array handling to "json" or "join".`,
      ]
    : [];
}

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** CSV injection protection: cells starting with = + - @ (or tab/CR) that aren't numbers get a ' prefix. */
export function protectInjection(s: string): string {
  if (s === '') return s;
  const c = s.charCodeAt(0);
  // = + - @ \t \r
  if (c === 0x3d || c === 0x2b || c === 0x2d || c === 0x40 || c === 0x09 || c === 0x0d) {
    return NUMERIC.test(s) ? s : `'${s}`;
  }
  return s;
}

/** RFC 4180 escaping. */
export function escapeCell(s: string, delimiter: string, quoteAll: boolean): string {
  if (quoteAll || s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function cell(s: string, opts: CsvOptions): string {
  return escapeCell(opts.injectionProtection ? protectInjection(s) : s, opts.delimiter, opts.quoteAll);
}

export function headerLine(columns: string[], opts: CsvOptions): string {
  // Header cells are escaped but not injection-prefixed (they are our own column names).
  return columns.map((c) => escapeCell(c, opts.delimiter, opts.quoteAll)).join(opts.delimiter) + opts.eol;
}

/** Formats one already-flattened row. */
export function rowCells(flat: Map<string, string>, columns: string[]): string[] {
  return columns.map((c) => flat.get(c) ?? '');
}

/**
 * Pass 2: yields CSV text line by line (BOM and header first). Pure and synchronous; the worker drives
 * it in time slices, batching lines into ~1 MB chunks.
 */
export function* generateCsv(records: unknown[], columns: string[], opts: CsvOptions): Generator<string> {
  const ctx = makeContext(opts);
  let first = opts.bom ? '\uFEFF' : '';
  if (opts.header) {
    yield first + headerLine(columns, opts);
    first = '';
  }
  const d = opts.delimiter;
  for (const row of iterRows(records, opts)) {
    const flat = flattenRecord(row, ctx);
    let line = first;
    first = '';
    for (let c = 0; c < columns.length; c++) {
      if (c > 0) line += d;
      const v = flat.get(columns[c]);
      if (v !== undefined && v !== '') line += cell(v, opts);
      else if (opts.quoteAll) line += '""';
    }
    yield line + opts.eol;
  }
  if (first) yield first;
}

/** Convenience for tests and small inputs. */
export function toCsv(source: unknown, options: Partial<CsvOptions> = {}): string {
  const opts = { ...DEFAULT_CSV_OPTIONS, ...options };
  const records = getRecords(source);
  const columns = computeColumns(records, opts);
  let out = '';
  for (const line of generateCsv(records, columns, opts)) out += line;
  return out;
}

/** First `limit` rows as unescaped cell text, for the preview table. */
export function previewRows(
  records: unknown[],
  columns: string[],
  opts: CsvOptions,
  limit: number,
): string[][] {
  const ctx = makeContext(opts);
  const rows: string[][] = [];
  for (const row of iterRows(records, opts)) {
    if (rows.length >= limit) break;
    const cells = rowCells(flattenRecord(row, ctx), columns);
    rows.push(opts.injectionProtection ? cells.map(protectInjection) : cells);
  }
  return rows;
}
