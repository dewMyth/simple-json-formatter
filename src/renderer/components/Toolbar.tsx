import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Indent } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import {
  clearAll,
  collapseAll,
  expandAll,
  expandLevel,
  formatEditor,
  openCsvDialog,
  openDialog,
  pasteFromClipboard,
  resolvedTheme,
  saveJson,
  toggleTheme,
  updateSettings,
} from '../lib/actions';
import { SearchBar } from './SearchBar';
import s from '../styles/ui.module.css';

function useDismiss(open: boolean, close: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function FormatMenu({ disabled }: { disabled: boolean }) {
  const settings = useAppStore((st) => st.settings)!;
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className={s.splitBtn} ref={ref}>
      <button
        className={`${s.tbBtn} ${s.tbBtnPrimary}`}
        disabled={disabled}
        onClick={() => void formatEditor(false)}
        data-testid="btn-format"
        title="Smart format the text"
      >
        Format
      </button>
      <button
        className={`${s.tbBtn} ${s.tbBtnPrimary} ${s.caretBtn}`}
        disabled={disabled}
        aria-label="Format settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ▾
      </button>
      {open && (
        <div className={s.popover} role="dialog" aria-label="Format settings">
          <label className={s.field}>
            <span>Indent</span>
            <select
              value={String(settings.indent)}
              onChange={(e) =>
                updateSettings({
                  indent: (e.target.value === '\t' ? '\t' : Number(e.target.value)) as Indent,
                })
              }
            >
              <option value="2">2 spaces</option>
              <option value="4">4 spaces</option>
              <option value={'\t'}>Tab</option>
            </select>
          </label>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={settings.sortKeys}
              onChange={(e) => updateSettings({ sortKeys: e.target.checked })}
            />
            Sort keys (alphabetical, recursive)
          </label>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={settings.autoFormatOnPaste}
              onChange={(e) => updateSettings({ autoFormatOnPaste: e.target.checked })}
            />
            Format automatically on paste
          </label>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={settings.expandNested}
              onChange={(e) => updateSettings({ expandNested: e.target.checked })}
            />
            Expand nested stringified JSON
          </label>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={settings.bigNumbers}
              onChange={(e) => updateSettings({ bigNumbers: e.target.checked })}
            />
            Big-number safety (keep digits exactly)
          </label>
          <label className={s.field}>
            <span>Editor size limit</span>
            <span>
              <input
                type="number"
                min={1}
                max={1024}
                value={settings.editorMaxMB}
                onChange={(e) => updateSettings({ editorMaxMB: Math.max(1, Number(e.target.value) || 25) })}
                style={{ width: 64 }}
              />{' '}
              MB
            </span>
          </label>
          <label className={s.field}>
            <span>Theme</span>
            <select
              value={settings.theme}
              onChange={(e) => updateSettings({ theme: e.target.value as 'system' | 'light' | 'dark' })}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <p className={s.hint}>Settings apply the next time you format.</p>
        </div>
      )}
    </div>
  );
}

function LevelMenu({ disabled }: { disabled: boolean }) {
  return (
    <select
      className={s.tbSelect}
      disabled={disabled}
      aria-label="Expand to level"
      value=""
      onChange={(e) => {
        if (e.target.value) expandLevel(Number(e.target.value));
      }}
    >
      <option value="">Level…</option>
      {[1, 2, 3, 4, 5, 6, 8, 10].map((l) => (
        <option key={l} value={l}>
          Level {l}
        </option>
      ))}
    </select>
  );
}

export function Toolbar({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }): React.JSX.Element {
  const busy = useAppStore((st) => st.job?.shown ?? false);
  const hasDoc = useAppStore((st) => st.doc !== null);
  const theme = useAppStore((st) => st.settings?.theme ?? 'system');
  const dark = resolvedTheme(theme) === 'dark';
  return (
    <header className={s.toolbar} role="toolbar" aria-label="Main toolbar">
      <div className={s.tbGroup}>
        <button
          className={s.tbBtn}
          disabled={busy}
          onClick={() => void openDialog()}
          title="Open a file (⌘O)"
        >
          Open
        </button>
        <button
          className={s.tbBtn}
          disabled={busy}
          onClick={() => void pasteFromClipboard()}
          title="Paste and format (⌘⇧V)"
          data-testid="btn-paste"
        >
          Paste
        </button>
        <FormatMenu disabled={busy} />
        <button className={s.tbBtn} disabled={busy} onClick={() => void formatEditor(true)} title="Minify">
          Minify
        </button>
        <button className={s.tbBtn} disabled={busy} onClick={clearAll} title="Clear everything">
          Clear
        </button>
      </div>
      <span className={s.tbSep} />
      <div className={s.tbGroup}>
        <button
          className={s.tbBtn}
          disabled={busy || !hasDoc}
          onClick={expandAll}
          data-testid="btn-expand-all"
        >
          Expand all
        </button>
        <button
          className={s.tbBtn}
          disabled={busy || !hasDoc}
          onClick={collapseAll}
          data-testid="btn-collapse-all"
        >
          Collapse all
        </button>
        <LevelMenu disabled={busy || !hasDoc} />
      </div>
      <span className={s.tbSep} />
      <SearchBar ref={searchRef} disabled={busy} />
      <span className={s.tbSep} />
      <div className={s.tbGroup}>
        <button
          className={s.tbBtn}
          disabled={busy || !hasDoc}
          onClick={() => openCsvDialog(0)}
          title="Export CSV (⌘E)"
          data-testid="btn-export-csv"
        >
          Export CSV
        </button>
        <button
          className={s.tbBtn}
          disabled={busy || !hasDoc}
          onClick={() => void saveJson()}
          title="Save formatted JSON (⌘S)"
        >
          Save JSON
        </button>
      </div>
      <button
        className={`${s.tbBtn} ${s.iconBtn}`}
        onClick={toggleTheme}
        aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        title={dark ? 'Light theme' : 'Dark theme'}
        data-testid="btn-theme"
      >
        {dark ? '☀' : '☾'}
      </button>
    </header>
  );
}
