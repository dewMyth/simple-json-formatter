# JSONLens

A fast, offline desktop JSON viewer, smart formatter and CSV exporter for macOS, Windows and Linux (Electron).

- **Smart format.** Paste messy JSON and get valid, pretty-printed JSON back. It handles escaped or double-stringified JSON, literal `\n`/`\t` between tokens, JSONP, code fences, log prefixes, trailing commas, single quotes, comments, Python literals, NDJSON and big integers (kept exactly).
- **Tree viewer.** A virtualised tree with colour-coded type badges, a property panel, keyboard navigation, search (keys/values, case, whole word, regex) and a context menu.
- **CSV export.** Nested data is flattened. Arrays can be joined, split into index columns, exploded into rows or written as JSON. You get a live preview, and the output streams to disk.
- **Large payloads.** All parsing, repair, formatting, indexing, search and CSV work runs in a Web Worker. Jobs over 150 ms show a loader you can cancel.

## Using it

| Action             | How                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load JSON          | Paste into the Text tab (it formats automatically), use **Paste**, **Open… (⌘O)**, drop a file anywhere, or pass a file on the command line                                                 |
| Re-format / minify | **Format** / **Minify**. The **▾** menu sets indent, sort keys, paste behaviour, nested-JSON expansion, big-number safety, editor size limit and theme                                      |
| Switch views       | **Text (⌘1)** / **Viewer (⌘2)**                                                                                                                                                             |
| Tree               | Click to select. Double-click or click the chevron to toggle; Alt+click toggles the whole subtree. Use ↑ ↓ ← → Home End PgUp PgDn Enter, and right-click for copy, expand or export actions |
| Search             | Type in the search box (250 ms debounce). Enter / Shift+Enter move between results. **K V Aa W .\*** toggle keys, values, case, whole word and regex                                        |
| Export             | **Export CSV (⌘E)**, **Save JSON (⌘S)**. Esc cancels a running job                                                                                                                          |

Documents whose formatted text is over 25 MB (configurable) open in the tree only. A banner offers **Load in editor anyway** and **Save formatted JSON…**.

## Development

```bash
npm install
npm run fixtures            # generate perf fixtures into ./fixtures (add -- --huge for the 200 MB one)
npm run dev                 # electron-vite dev server with HMR
npm test                    # unit tests (Vitest)
npm run test:coverage       # with coverage
npm run e2e                 # build, then Playwright end-to-end tests against the real app
npm run typecheck && npm run lint
npm run build && npm run dist   # installers in ./dist: dmg (arm64 + x64), NSIS, AppImage
```

> If you run Electron from a VS Code terminal, `ELECTRON_RUN_AS_NODE=1` may be set and stop Electron from starting. Unset it first. The e2e suite strips it automatically.

To regenerate the golden CSV used by the e2e test, run `UPDATE_GOLDEN=1 npx vitest run src/worker/golden.test.ts`.

### Layout

```
src/main/       window, menus, jsonlens:// protocol, IPC, streaming export writer, electron-store
src/preload/    typed contextBridge API (window.api)
src/shared/     types (TreeIndex, RPC contract), constants (APP_NAME, thresholds), JSONPath
src/worker/     json.worker (RPC dispatcher), session, sanitize, escapeScanner, jsonError,
                indexBuilder, format, search, flatten, csv   (pure, unit-tested)
src/renderer/   React UI, Zustand store, workerClient (RPC, progress, cancel/respawn)
e2e/            Playwright tests + golden files
```

### How it stays fast

- The parsed document lives only in the worker. The UI gets a flat pre-order index of typed arrays, transferred with no copy. Keys are interned, and keys and previews are packed into UTF-16 string tables, so the UI never deserialises millions of strings in one task.
- Visible rows are computed in O(visible) from the `subtreeEnd` array, and expand/collapse is a bitset. The tree mounts about 50–70 rows, and its virtualiser scales scrolling past the browser's maximum element height.
- Files are read by the worker straight from main through the `jsonlens://` protocol (fetch with progress), so file bytes never cross the UI thread.
- Exports stream from the worker to main in ~1 MB chunks over a `MessagePort`. Main writes them to a temporary file and renames it at the end, so a cancelled export leaves nothing behind.
- Cancelling a long-running search, preview or export is cooperative. Cancelling a load or format terminates the worker; a fresh worker then reloads the previous document in the background.

### Measured (Apple Silicon laptop)

| Check                                                                                             | Budget             | Result                                             |
| ------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------- |
| medium.json (100k lines, 3.6 MB) open → tree                                                      | < 1.5 s            | ~120 ms in the app (~80 ms parse + index + format) |
| Main-thread long tasks during load, expand/collapse all, scroll, search, format, CSV export, save | none > 100 ms      | none over 50 ms                                    |
| large.json fully expanded (~1M rows)                                                              | < 150 rows mounted | ~60                                                |
| Toggle one node / expand + collapse all on large.json                                             | < 50 ms / < 300 ms | passes                                             |
| Search medium.json                                                                                | < 500 ms           | passes                                             |
| CSV export, 10k rows                                                                              | < 3 s              | ~0.6 s                                             |
| huge.json (200 MB)                                                                                | must not crash     | opens in ~6 s, tree view only                      |

### Notable decisions

Most are marked with `// DECISION:` in the code.

- The index packs keys and previews into transferable string tables instead of the `string[]` arrays sketched in the plan (rule 3: no deep object graphs across threads).
- The worker keeps one value reference per node, which makes `getValue`, search and CSV source lookup O(1).
- The tree uses a small fixed-row virtualiser, because rows × 22 px exceeds the browser's maximum element height for very large documents. `@tanstack/react-virtual` is used for the property panel and the CSV preview.
- NDJSON detection runs before the generic `jsonrepair` step, so the fix message is more precise.
- Editor linting runs `JSON.parse` in the worker, not on the UI thread.
- Styling uses CSS Modules with theme variables. Badge text uses darker shades of the plan's hues so that every badge meets WCAG AA; this is enforced by `contrast.test.ts`.
