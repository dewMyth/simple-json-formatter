// ───────────────────────── Node types ─────────────────────────

export const NodeType = {
  Object: 0,
  Array: 1,
  String: 2,
  Number: 3,
  Boolean: 4,
  Null: 5,
  BigNumber: 6,
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const NODE_TYPE_NAMES = ['object', 'array', 'string', 'number', 'boolean', 'null', 'bignum'] as const;

/** Node flag bits (TreeIndex.flags). */
export const NodeFlag = {
  /** The preview was truncated; the full value must be fetched with getValue. */
  Truncated: 1,
} as const;

// ───────────────────────── Tree index ─────────────────────────

/**
 * Many strings packed into one UTF-16 buffer so they can be *transferred* between threads
 * instead of structured-cloned as millions of separate strings.
 * String i is data[offsets[i] .. offsets[i+1]).
 */
export interface StringTable {
  data: Uint16Array;
  offsets: Uint32Array;
}

/**
 * Flat pre-order index of the JSON document. All per-node arrays have length n; node 0 is the root.
 *
 * DECISION: plan.md sketches `keys: string[]` and `preview: string[]` (structured-cloned). Cloning
 * millions of strings is deserialised on the UI thread in one task, which breaks the 100 ms rule on
 * large documents. Instead keys are interned (`keyId` → `keys` table) and both tables are packed into
 * transferable typed arrays (StringTable). Use `getKey`/`getPreview` in renderer/lib/visible.ts.
 */
export interface TreeIndex {
  n: number;
  type: Uint8Array;
  depth: Uint16Array;
  /** -1 for root */
  parent: Int32Array;
  /** index one past the last descendant */
  subtreeEnd: Int32Array;
  childCount: Int32Array;
  /** index into `keys`, or -1 for array items / root */
  keyId: Int32Array;
  /** index within parent array, else -1 */
  arrayIndex: Int32Array;
  /** NodeFlag bits */
  flags: Uint8Array;
  /** unique property names */
  keys: StringTable;
  /** per-node preview of primitive values (empty for containers; the UI derives "{12}" / "[3400]") */
  preview: StringTable;
  maxDepth: number;
}

// ───────────────────────── Sanitiser ─────────────────────────

export interface SanitizeError {
  message: string;
  line: number;
  column: number;
  /** offset into the (BOM-stripped, LF-normalised) source text */
  offset: number;
  snippet: string;
}

export interface SanitizeResult {
  ok: boolean;
  /** parsed root (stays in worker) */
  value?: unknown;
  fixes: string[];
  error?: SanitizeError;
  usedLossless: boolean;
}

export interface SanitizeOptions {
  /** Replace string values that contain JSON objects/arrays with the parsed value. */
  expandNested: boolean;
  /** Parse with lossless-json when big numbers are present. */
  bigNumbers: boolean;
}

export type Indent = 2 | 4 | '\t';

export interface FormatOptions {
  indent: Indent;
  sortKeys: boolean;
  minify: boolean;
}

export interface LoadOptions extends SanitizeOptions, FormatOptions {
  /** Return formatted text only if it is smaller than this (bytes). 0 = never. */
  editorMaxBytes: number;
}

export interface Stats {
  bytes: number;
  lines: number;
  nodes: number;
  maxDepth: number;
  parseMs: number;
  totalMs: number;
}

// ───────────────────────── Search ─────────────────────────

export interface SearchOptions {
  keys: boolean;
  values: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchResult {
  ids: Int32Array;
  /** true when the result cap was hit */
  more: boolean;
}

// ───────────────────────── CSV ─────────────────────────

export type ArrayMode = 'auto' | 'join' | 'index' | 'explode' | 'json';

export interface FlattenOptions {
  /** path separator for column names */
  separator: '.' | '/' | '_';
  /** 0 = unlimited. Anything deeper is written as a JSON string. */
  maxDepth: number;
  /** global default. 'auto' = join for primitive arrays, json for arrays containing objects/arrays */
  arrayMode: Exclude<ArrayMode, 'explode'>;
  /** per-path override, keyed by the array's column path with index segments removed */
  arrayOverrides: Record<string, Exclude<ArrayMode, 'explode'>>;
  joinSeparator: string;
  /** max columns per array in 'index' mode */
  indexCap: number;
  /** path segments (relative to each record) of the one array to explode, or null */
  explodePath: string[] | null;
}

export interface CsvOptions extends FlattenOptions {
  /** node id of the array (or object) to convert */
  sourceNode: number;
  delimiter: ',' | ';' | '\t' | '|';
  quoteAll: boolean;
  header: boolean;
  bom: boolean;
  eol: '\n' | '\r\n';
  nullAs: 'empty' | 'null';
  boolCase: 'lower' | 'upper';
  injectionProtection: boolean;
}

export interface CsvCandidate {
  nodeId: number;
  path: string;
  length: number;
  kind: 'objects' | 'primitives' | 'object' | 'mixed';
}

export interface CsvExplodeCandidate {
  segments: string[];
  label: string;
}

export interface CsvPreview {
  columns: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  warnings: string[];
  explodeCandidates: CsvExplodeCandidate[];
  /** column paths (index segments removed) of arrays found in the records, for per-path overrides */
  arrayPaths: string[];
}

export interface CsvExportResult {
  rows: number;
  columns: number;
  bytes: number;
}

// ───────────────────────── Worker RPC ─────────────────────────

/** A loadable source: raw bytes, a File (drag-drop), a URL served by main, or text. */
export type Req =
  | { id: number; kind: 'load'; buffer: ArrayBuffer; opts: LoadOptions }
  | { id: number; kind: 'loadFile'; file: Blob; opts: LoadOptions }
  | { id: number; kind: 'loadUrl'; url: string; opts: LoadOptions }
  | { id: number; kind: 'loadText'; text: string; opts: LoadOptions }
  | { id: number; kind: 'format'; indent: Indent; sortKeys: boolean; minify: boolean }
  | { id: number; kind: 'getValue'; nodeId: number; asText: boolean; indent?: Indent }
  | { id: number; kind: 'search'; query: string; opts: SearchOptions }
  | { id: number; kind: 'lint'; text: string }
  | { id: number; kind: 'csvCandidates'; fromNode: number }
  | { id: number; kind: 'csvPreview'; opts: CsvOptions; limit: number }
  | { id: number; kind: 'csvExport'; opts: CsvOptions; port: MessagePort }
  | { id: number; kind: 'saveJson'; indent: Indent; minify: boolean; port: MessagePort }
  /** cooperative cancel of a running async job */
  | { id: number; kind: 'cancel'; targetId: number };

export type ReqKind = Req['kind'];

export interface LoadedPayload {
  index: TreeIndex;
  fixes: string[];
  stats: Stats;
  /** pretty-printed (or minified) text, when below the editor threshold */
  formatted?: string;
  /** size in bytes of the formatted output (or an estimate when it wasn't produced) */
  formattedBytes: number;
  usedLossless: boolean;
}

export type Res =
  | { id: number; kind: 'progress'; stage: string; pct?: number }
  | ({ id: number; kind: 'loaded' } & LoadedPayload)
  | { id: number; kind: 'error'; error: SanitizeError; sourceText?: string }
  | { id: number; kind: 'cancelled' }
  | { id: number; kind: 'result'; data: unknown };

/** Messages the worker sends to main over an export MessagePort. */
export type ExportPortMsg = { type: 'chunk'; data: string } | { type: 'end' } | { type: 'abort' };
/** Messages main sends back over the export port. */
export type ExportPortReply = { type: 'finished'; bytes: number } | { type: 'error'; message: string };

// ───────────────────────── Settings / preload API ─────────────────────────

export type ThemePref = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemePref;
  lastTab: 'text' | 'viewer';
  indent: Indent;
  sortKeys: boolean;
  autoFormatOnPaste: boolean;
  expandNested: boolean;
  bigNumbers: boolean;
  editorMaxMB: number;
  treeWidth: number;
  csv: Partial<CsvOptions>;
  recentFiles: string[];
}

export interface OpenedFile {
  path: string;
  name: string;
  size: number;
  /** URL the worker can fetch the bytes from (served by main) */
  url: string;
}

export type MenuCommand =
  | 'open'
  | 'save-json'
  | 'export-csv'
  | 'paste-format'
  | 'tab-text'
  | 'tab-viewer'
  | 'expand-all'
  | 'collapse-all'
  | 'toggle-theme'
  | 'find';

export interface SaveTarget {
  path: string;
  exportId: number;
}

export interface JsonLensApi {
  platform: string;
  isE2E: boolean;
  /** Files passed on the command line / via the OS before the renderer was ready. */
  getPendingFiles(): Promise<OpenedFile[]>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  openFileDialog(): Promise<OpenedFile | null>;
  openPath(path: string): Promise<OpenedFile | null>;
  /** fallback when the worker can't fetch the URL */
  readFile(path: string): Promise<ArrayBuffer>;
  pathForFile(file: File): string;
  addRecent(path: string): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  /** Shows the save dialog. Returns null if cancelled. */
  chooseSavePath(kind: 'csv' | 'json', suggestedName: string): Promise<SaveTarget | null>;
  /**
   * Creates a MessageChannel; one end goes to main's writer for `exportId`, the other is posted to the
   * page as a window message `{ type: 'jsonlens:export-port', exportId }` with the port attached.
   */
  openExportPort(exportId: number): void;
  cancelExport(exportId: number): Promise<void>;
  showInFolder(path: string): Promise<void>;
  setNativeTheme(theme: ThemePref): void;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  onOpenFile(cb: (file: OpenedFile) => void): () => void;
  onExportProgress(cb: (p: { exportId: number; bytes: number }) => void): () => void;
}
