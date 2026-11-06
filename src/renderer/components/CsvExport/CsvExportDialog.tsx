import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArrayMode, CsvCandidate, CsvOptions, CsvPreview as Preview } from '@shared/types';
import { DEFAULT_CSV_OPTIONS } from '@worker/csv';
import { getState, useAppStore, setState } from '../../store/useAppStore';
import { csvCandidates, csvPreview, exportCsv, updateSettings } from '../../lib/actions';
import { fmtInt, getLabel } from '../../lib/visible';
import { CsvPreview } from './CsvPreview';
import s from '../../styles/ui.module.css';

type Persisted = Omit<CsvOptions, 'sourceNode' | 'explodePath' | 'arrayOverrides'>;
const PERSISTED_KEYS: Array<keyof Persisted> = [
  'separator',
  'maxDepth',
  'arrayMode',
  'joinSeparator',
  'indexCap',
  'delimiter',
  'quoteAll',
  'header',
  'bom',
  'eol',
  'nullAs',
  'boolCase',
  'injectionProtection',
];

function initialOptions(saved: Partial<CsvOptions>): CsvOptions {
  const eol = window.api.platform === 'win32' ? '\r\n' : '\n';
  const picked: Partial<CsvOptions> = {};
  for (const k of PERSISTED_KEYS)
    if (saved[k] !== undefined) (picked as Record<string, unknown>)[k] = saved[k];
  return { ...DEFAULT_CSV_OPTIONS, eol, ...picked, arrayOverrides: {}, explodePath: null };
}

const DELIMS: Array<[CsvOptions['delimiter'], string]> = [
  [',', 'Comma ,'],
  [';', 'Semicolon ;'],
  ['\t', 'Tab'],
  ['|', 'Pipe |'],
];

export function CsvExportDialog(): React.JSX.Element | null {
  const dialog = useAppStore((st) => st.csvDialog);
  if (!dialog) return null;
  return <Dialog fromNode={dialog.fromNode} />;
}

function Dialog({ fromNode: initialFrom }: { fromNode: number }) {
  const doc = useAppStore((st) => st.doc)!;
  const selected = useAppStore((st) => st.selected);
  const saved = useAppStore((st) => st.settings?.csv ?? {});
  const [scope, setScope] = useState<'root' | 'node'>(initialFrom > 0 ? 'node' : 'root');
  const nodeForScope = scope === 'root' ? 0 : initialFrom > 0 ? initialFrom : Math.max(0, selected);
  const [candidates, setCandidates] = useState<CsvCandidate[] | null>(null);
  const [opts, setOpts] = useState<CsvOptions>(() => initialOptions(saved));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const first = useRef<HTMLSelectElement>(null);

  const set = <K extends keyof CsvOptions>(k: K, v: CsvOptions[K]): void =>
    setOpts((o) => ({ ...o, [k]: v }));

  // 1. candidate arrays under the chosen node
  useEffect(() => {
    let live = true;
    setCandidates(null);
    csvCandidates(nodeForScope).then(
      (c) => {
        if (!live) return;
        setCandidates(c);
        // largest array of objects by default, else the node itself
        const best = c.find((x) => x.kind === 'objects') ?? c[c.length - 1];
        setOpts((o) => ({
          ...o,
          sourceNode: best?.nodeId ?? nodeForScope,
          explodePath: null,
          arrayOverrides: {},
        }));
      },
      (e: Error) => live && setPreviewError(e.message),
    );
    return () => {
      live = false;
    };
  }, [nodeForScope]);

  // 2. live preview, debounced
  useEffect(() => {
    if (!candidates) return;
    setLoading(true);
    const t = setTimeout(() => {
      csvPreview(opts).then(
        (p) => {
          if (!p) return;
          setPreview(p);
          setPreviewError(null);
          setLoading(false);
        },
        (e: Error) => {
          setPreviewError(e.message);
          setLoading(false);
        },
      );
    }, 200);
    return () => clearTimeout(t);
  }, [opts, candidates]);

  useEffect(() => first.current?.focus(), []);

  // Esc closes the dialog wherever focus is (it may have left the modal while the source select was disabled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !getState().job?.shown) {
        e.preventDefault();
        setState({ csvDialog: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = (): void => setState({ csvDialog: null });
  const doExport = (): void => {
    const persist: Partial<CsvOptions> = {};
    for (const k of PERSISTED_KEYS) (persist as Record<string, unknown>)[k] = opts[k];
    updateSettings({ csv: persist });
    const base = (doc.name ?? 'data').replace(/\.[^.]+$/, '');
    const node = opts.sourceNode > 0 ? `-${getLabel(doc.index, opts.sourceNode)}` : '';
    void exportCsv(opts, `${base}${node}.csv`.replace(/[\\/:*?"<>|]/g, '_'));
  };

  const explodeValue = opts.explodePath ? JSON.stringify(opts.explodePath) : '';
  const overrideModes: Array<Exclude<ArrayMode, 'explode'>> = ['join', 'index', 'json'];
  const arrayPaths = useMemo(() => (preview?.arrayPaths ?? []).slice(0, 50), [preview]);

  return (
    <div className={s.modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className={s.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-title"
        data-testid="csv-dialog"
      >
        <header className={s.modalHeader}>
          <h2 id="csv-title">Export CSV</h2>
          <button className={s.smallBtn} onClick={close} aria-label="Close">
            ✕
          </button>
        </header>
        <div className={s.modalBody}>
          <div className={s.csvOptions}>
            <fieldset className={s.fieldset}>
              <legend>1. Source</legend>
              <div className={s.radioRow}>
                <label className={s.check}>
                  <input type="radio" checked={scope === 'root'} onChange={() => setScope('root')} /> Whole
                  document
                </label>
                <label className={s.check}>
                  <input
                    type="radio"
                    checked={scope === 'node'}
                    onChange={() => setScope('node')}
                    disabled={selected <= 0 && initialFrom <= 0}
                  />{' '}
                  Selected node
                </label>
              </div>
              <label className={s.field}>
                <span>Array to convert</span>
                <select
                  ref={first}
                  value={opts.sourceNode}
                  disabled={!candidates}
                  data-testid="csv-source"
                  onChange={(e) =>
                    setOpts((o) => ({
                      ...o,
                      sourceNode: Number(e.target.value),
                      explodePath: null,
                      arrayOverrides: {},
                    }))
                  }
                >
                  {!candidates && <option>Scanning…</option>}
                  {candidates?.map((c) => (
                    <option key={c.nodeId} value={c.nodeId}>
                      {c.path} {c.kind === 'object' ? '(one row)' : `[${fmtInt(c.length)}]`}
                      {c.kind === 'primitives' ? ' values' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>

            <fieldset className={s.fieldset}>
              <legend>2. Flattening</legend>
              <label className={s.field}>
                <span>Path separator</span>
                <select
                  value={opts.separator}
                  onChange={(e) => set('separator', e.target.value as CsvOptions['separator'])}
                >
                  <option value=".">. (user.address.city)</option>
                  <option value="/">/ (user/address/city)</option>
                  <option value="_">_ (user_address_city)</option>
                </select>
              </label>
              <label className={s.field}>
                <span>Max depth</span>
                <input
                  type="number"
                  min={0}
                  value={opts.maxDepth}
                  onChange={(e) => set('maxDepth', Math.max(0, Number(e.target.value) || 0))}
                  title="0 = unlimited; deeper values are written as JSON"
                  style={{ width: 70 }}
                />
              </label>
              <label className={s.field}>
                <span>Arrays</span>
                <select
                  value={opts.arrayMode}
                  onChange={(e) => set('arrayMode', e.target.value as CsvOptions['arrayMode'])}
                  data-testid="csv-array-mode"
                >
                  <option value="auto">Auto (join values, JSON for objects)</option>
                  <option value="join">Join values</option>
                  <option value="index">One column per index</option>
                  <option value="json">JSON in one cell</option>
                </select>
              </label>
              <label className={s.field}>
                <span>Join with</span>
                <input
                  value={opts.joinSeparator}
                  onChange={(e) => set('joinSeparator', e.target.value)}
                  style={{ width: 70 }}
                />
              </label>
              <label className={s.field}>
                <span>Index columns cap</span>
                <input
                  type="number"
                  min={1}
                  value={opts.indexCap}
                  onChange={(e) => set('indexCap', Math.max(1, Number(e.target.value) || 50))}
                  style={{ width: 70 }}
                />
              </label>
              <label className={s.field}>
                <span>Explode (one row per element)</span>
                <select
                  value={explodeValue}
                  data-testid="csv-explode"
                  onChange={(e) =>
                    set('explodePath', e.target.value ? (JSON.parse(e.target.value) as string[]) : null)
                  }
                >
                  <option value="">None</option>
                  {preview?.explodeCandidates.map((c) => (
                    <option key={c.label} value={JSON.stringify(c.segments)}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              {opts.explodePath && preview && (
                <p className={s.hint}>Estimated rows after exploding: {fmtInt(preview.totalRows)}</p>
              )}
              {arrayPaths.length > 0 && (
                <details className={s.details}>
                  <summary>Per-array overrides ({arrayPaths.length})</summary>
                  {arrayPaths.map((p) => (
                    <label key={p} className={s.field}>
                      <span className="mono" title={p}>
                        {p}
                      </span>
                      <select
                        value={opts.arrayOverrides[p] ?? ''}
                        onChange={(e) => {
                          const rest = Object.fromEntries(
                            Object.entries(opts.arrayOverrides).filter(([k]) => k !== p),
                          );
                          set(
                            'arrayOverrides',
                            e.target.value
                              ? { ...rest, [p]: e.target.value as Exclude<ArrayMode, 'explode'> }
                              : rest,
                          );
                        }}
                      >
                        <option value="">Default</option>
                        {overrideModes.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </details>
              )}
            </fieldset>

            <fieldset className={s.fieldset}>
              <legend>3. Output</legend>
              <label className={s.field}>
                <span>Delimiter</span>
                <select
                  value={opts.delimiter}
                  onChange={(e) => set('delimiter', e.target.value as CsvOptions['delimiter'])}
                >
                  {DELIMS.map(([v, l]) => (
                    <option key={l} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.field}>
                <span>Quote</span>
                <select
                  value={opts.quoteAll ? 'all' : 'needed'}
                  onChange={(e) => set('quoteAll', e.target.value === 'all')}
                >
                  <option value="needed">Only when needed</option>
                  <option value="all">Always</option>
                </select>
              </label>
              <label className={s.field}>
                <span>Line endings</span>
                <select value={opts.eol} onChange={(e) => set('eol', e.target.value as CsvOptions['eol'])}>
                  <option value={'\n'}>LF</option>
                  <option value={'\r\n'}>CRLF</option>
                </select>
              </label>
              <label className={s.field}>
                <span>null as</span>
                <select
                  value={opts.nullAs}
                  onChange={(e) => set('nullAs', e.target.value as CsvOptions['nullAs'])}
                >
                  <option value="empty">Empty cell</option>
                  <option value="null">null</option>
                </select>
              </label>
              <label className={s.field}>
                <span>Booleans</span>
                <select
                  value={opts.boolCase}
                  onChange={(e) => set('boolCase', e.target.value as CsvOptions['boolCase'])}
                >
                  <option value="lower">true / false</option>
                  <option value="upper">TRUE / FALSE</option>
                </select>
              </label>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={opts.header}
                  onChange={(e) => set('header', e.target.checked)}
                />{' '}
                Header row
              </label>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={opts.bom}
                  onChange={(e) => set('bom', e.target.checked)}
                  data-testid="csv-bom"
                />{' '}
                Excel compatibility (UTF-8 BOM)
              </label>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={opts.injectionProtection}
                  onChange={(e) => set('injectionProtection', e.target.checked)}
                />{' '}
                Protect against formula injection
              </label>
            </fieldset>
          </div>

          <section className={s.csvPreviewPane} aria-label="Preview">
            <div className={s.csvPreviewHead}>
              <strong>4. Preview</strong>
              <span className={s.muted} data-testid="csv-totals">
                {preview
                  ? `${fmtInt(preview.totalRows)} rows × ${fmtInt(preview.totalColumns)} columns${
                      preview.rows.length < preview.totalRows
                        ? ` · showing first ${fmtInt(preview.rows.length)}`
                        : ''
                    }`
                  : ''}
                {loading ? ' · updating…' : ''}
              </span>
            </div>
            {preview?.warnings.map((w) => (
              <div key={w} className={`${s.banner} ${s.bannerWarn}`}>
                {w}
              </div>
            ))}
            {previewError && <div className={`${s.banner} ${s.bannerError}`}>{previewError}</div>}
            {preview ? (
              <CsvPreview preview={preview} />
            ) : (
              <div className={s.propEmpty}>Building preview…</div>
            )}
          </section>
        </div>
        <footer className={s.modalFooter}>
          <button className={s.tbBtn} onClick={close}>
            Cancel
          </button>
          <button
            className={`${s.tbBtn} ${s.tbBtnPrimary}`}
            onClick={doExport}
            disabled={!preview}
            data-testid="csv-export"
          >
            Export…
          </button>
        </footer>
      </div>
    </div>
  );
}
