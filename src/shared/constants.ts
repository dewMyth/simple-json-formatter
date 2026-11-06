/** Working name of the app. Change it here only. */
export const APP_NAME = 'JSONLens';

/** Loader overlay appears only when a job runs longer than this. */
export const LOADER_DELAY_MS = 150;

/** Formatted text above this size isn't loaded into the editor automatically. */
export const EDITOR_MAX_BYTES = 25 * 1024 * 1024;

/** Editor linting is switched off above this size. */
export const LINT_MAX_BYTES = 2 * 1024 * 1024;

/** Above this estimated output size the streaming serialiser is used instead of JSON.stringify. */
export const STREAM_SERIALIZE_BYTES = 50 * 1024 * 1024;

/** Value previews in the index are truncated to this many UTF-16 code units. */
export const PREVIEW_MAX_CHARS = 200;

/** Search results are capped at this many node ids. */
export const SEARCH_RESULT_CAP = 100_000;

/** Approximate size of each chunk streamed to disk. */
export const EXPORT_CHUNK_CHARS = 1024 * 1024;

/** Index builder posts progress every N nodes. */
export const INDEX_PROGRESS_EVERY = 50_000;

/** CSV generator posts progress every N rows. */
export const CSV_PROGRESS_EVERY = 1_000;

/** Warn when a CSV would have more columns than this. */
export const CSV_MAX_COLUMNS_WARN = 5_000;

/** Tree geometry. */
export const ROW_HEIGHT = 22;
export const INDENT_PX = 16;

/** The property panel switches to a virtualised grid above this many children. */
export const PROPERTY_VIRTUALIZE_AT = 200;

/** Search input debounce. */
export const SEARCH_DEBOUNCE_MS = 250;

/** Cooperative jobs in the worker yield to the event loop after this much work. */
export const WORKER_SLICE_MS = 30;

/** Custom protocol that serves the renderer bundle and authorised files. */
export const APP_SCHEME = 'jsonlens';
export const APP_HOST = 'app';

/** File extensions accepted by open/drop. */
export const OPENABLE_EXTENSIONS = ['json', 'txt', 'ndjson', 'jsonl', 'log', 'geojson'];
