import { useState } from 'react';
import { useAppStore, setState } from '../store/useAppStore';
import { editor } from '../lib/editorBridge';
import { loadEditorAnyway, saveJson } from '../lib/actions';
import { formatBytes } from '../lib/visible';
import { FixesList } from './StatusBar';
import s from '../styles/ui.module.css';

export function ErrorBanner(): React.JSX.Element | null {
  const error = useAppStore((st) => st.error);
  const hasDoc = useAppStore((st) => st.doc !== null);
  if (!error) return null;
  return (
    <div className={`${s.banner} ${s.bannerError}`} role="alert" data-testid="error-banner">
      <div className={s.bannerMain}>
        <strong>Couldn’t parse JSON:</strong> {error.message}{' '}
        <span className={s.muted}>
          (line {error.line}, column {error.column})
        </span>
        {hasDoc && <span className={s.muted}> · the previous tree is kept</span>}
        {error.snippet && <pre className={`${s.snippet} mono`}>{error.snippet}</pre>}
      </div>
      <div className={s.bannerActions}>
        <button
          className={s.smallBtn}
          onClick={() => editor()?.jumpTo(error.line, error.column)}
          data-testid="btn-jump-error"
        >
          Jump to error
        </button>
        <button className={s.smallBtn} onClick={() => setState({ error: null })} aria-label="Dismiss error">
          ✕
        </button>
      </div>
    </div>
  );
}

export function LargeDocBanner(): React.JSX.Element | null {
  const doc = useAppStore((st) => st.doc);
  if (!doc?.largeDoc) return null;
  return (
    <div className={`${s.banner} ${s.bannerWarn}`} role="status" data-testid="large-banner">
      <div className={s.bannerMain}>
        <strong>Large document:</strong> showing tree view ({formatBytes(doc.formattedBytes)} formatted).
      </div>
      <div className={s.bannerActions}>
        <button className={s.smallBtn} onClick={() => void loadEditorAnyway()}>
          Load in editor anyway
        </button>
        <button className={s.smallBtn} onClick={() => void saveJson()}>
          Save formatted JSON…
        </button>
      </div>
    </div>
  );
}

export function FixesChip(): React.JSX.Element | null {
  const fixes = useAppStore((st) => st.doc?.fixes);
  const error = useAppStore((st) => st.error);
  const [open, setOpen] = useState(false);
  if (!fixes?.length || error) return null;
  return (
    <div className={s.chipWrap}>
      <button className={s.chip} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="fixes-chip">
        ✓ Fixes applied ({fixes.length})
      </button>
      {open && (
        <div className={s.chipPanel}>
          <FixesList fixes={fixes} />
        </div>
      )}
    </div>
  );
}
