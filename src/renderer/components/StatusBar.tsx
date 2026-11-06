import { useAppStore, setState } from '../store/useAppStore';
import { fmtInt, formatBytes } from '../lib/visible';
import s from '../styles/ui.module.css';

export function FixesList({ fixes }: { fixes: string[] }) {
  return (
    <ul className={s.fixesList}>
      {fixes.map((f, i) => (
        <li key={i}>{f}</li>
      ))}
    </ul>
  );
}

export function StatusBar(): React.JSX.Element {
  const doc = useAppStore((st) => st.doc);
  const open = useAppStore((st) => st.fixesOpen);
  if (!doc) {
    return (
      <footer className={s.statusBar} data-testid="status-bar">
        <span className={s.muted}>Ready</span>
      </footer>
    );
  }
  const st = doc.stats;
  const parts = [
    formatBytes(st.bytes),
    `${fmtInt(st.lines)} lines`,
    `${fmtInt(st.nodes)} nodes`,
    `depth ${fmtInt(st.maxDepth)}`,
    `parsed in ${fmtInt(st.parseMs)} ms`,
  ];
  return (
    <footer className={s.statusBar} data-testid="status-bar">
      {parts.map((p) => (
        <span key={p} className={s.statusItem}>
          {p}
        </span>
      ))}
      {doc.usedLossless && <span className={s.statusItem}>big numbers kept exactly</span>}
      <span className={s.statusFixes}>
        <button
          className={s.linkBtn}
          disabled={doc.fixes.length === 0}
          onClick={() => setState({ fixesOpen: !open })}
          aria-expanded={open}
          data-testid="status-fixes"
        >
          fixes: {doc.fixes.length}
          {doc.fixes.length ? ' (click to view)' : ''}
        </button>
        {open && doc.fixes.length > 0 && (
          <div className={`${s.popover} ${s.popoverUp}`} role="dialog" aria-label="Fixes applied">
            <strong>Fixes applied</strong>
            <FixesList fixes={doc.fixes} />
          </div>
        )}
      </span>
    </footer>
  );
}
