import { useEffect, useRef, useState } from 'react';
import type { MenuCommand } from '@shared/types';
import { APP_NAME } from '@shared/constants';
import { getState, setState, useAppStore } from './store/useAppStore';
import * as actions from './lib/actions';
import { editor } from './lib/editorBridge';
import { Toolbar } from './components/Toolbar';
import { Tabs } from './components/Tabs';
import { StatusBar } from './components/StatusBar';
import { JsonEditor } from './components/Editor/JsonEditor';
import { TreeView } from './components/Tree/TreeView';
import { PropertyPanel } from './components/PropertyPanel';
import { LoaderOverlay } from './components/LoaderOverlay';
import { ErrorBanner, FixesChip, LargeDocBanner } from './components/ErrorBanner';
import { Toasts } from './components/Toast';
import { ContextMenu } from './components/ContextMenu';
import { CsvExportDialog } from './components/CsvExport/CsvExportDialog';
import s from './styles/ui.module.css';

function SplitView() {
  const width = useAppStore((st) => st.settings?.treeWidth ?? 0.6);
  const [w, setW] = useState(width);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setW(width), [width]);
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    let last = w;
    const move = (ev: PointerEvent): void => {
      last = Math.min(0.85, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      setW(last);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      actions.updateSettings({ treeWidth: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={s.split} ref={ref}>
      <div className={s.treePane} style={{ width: `${w * 100}%` }}>
        <TreeView />
      </div>
      <div
        className={s.splitter}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize tree and property panel"
        aria-valuenow={Math.round(w * 100)}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const next = Math.min(0.85, Math.max(0.2, w + (e.key === 'ArrowLeft' ? -0.05 : 0.05)));
            setW(next);
            actions.updateSettings({ treeWidth: next });
          }
        }}
      />
      <div className={s.propPane}>
        <PropertyPanel />
      </div>
    </div>
  );
}

function EmptyState({ where }: { where: 'text' | 'viewer' }) {
  return (
    <div className={s.empty} data-testid={`empty-${where}`}>
      <div className={s.emptyTitle}>Paste JSON or drop a file</div>
      <div className={s.muted}>
        Messy, escaped, double-stringified or slightly broken JSON is cleaned up automatically.
      </div>
      <div className={s.emptyActions}>
        <button className={`${s.tbBtn} ${s.tbBtnPrimary}`} onClick={() => void actions.pasteFromClipboard()}>
          Paste from clipboard
        </button>
        <button className={s.tbBtn} onClick={() => void actions.openDialog()}>
          Open a file…
        </button>
      </div>
      {where === 'text' && <div className={s.hint}>…or just type or paste into the editor below.</div>}
    </div>
  );
}

function TextTab() {
  const hasDoc = useAppStore((st) => st.doc !== null);
  const hasText = useAppStore((st) => st.editorPush.text.length > 0);
  const error = useAppStore((st) => st.error);
  const [typed, setTyped] = useState(false);
  return (
    <div className={s.textTab}>
      <ErrorBanner />
      <LargeDocBanner />
      <FixesChip />
      {!hasDoc && !hasText && !error && !typed && <EmptyState where="text" />}
      <div className={s.editorWrap} onKeyDown={() => setTyped(true)}>
        <JsonEditor />
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  const ready = useAppStore((st) => st.settings !== null);
  const tab = useAppStore((st) => st.tab);
  const hasDoc = useAppStore((st) => st.doc !== null);
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // startup: settings, theme, pending files, menu & file events
  useEffect(() => {
    let disposed = false;
    const offs: Array<() => void> = [];
    void (async () => {
      const settings = await window.api.getSettings();
      if (disposed) return;
      setState({ settings, tab: settings.lastTab });
      actions.applyTheme(settings.theme);
      const pending = await window.api.getPendingFiles();
      const last = pending.at(-1);
      if (last) void actions.openFile(last);
    })();

    const onMenu = (cmd: MenuCommand): void => {
      switch (cmd) {
        case 'open':
          return void actions.openDialog();
        case 'save-json':
          return void actions.saveJson();
        case 'export-csv':
          return actions.openCsvDialog(Math.max(0, getState().selected));
        case 'paste-format':
          return void actions.pasteFromClipboard();
        case 'tab-text':
          return actions.setTab('text');
        case 'tab-viewer':
          return actions.setTab('viewer');
        case 'expand-all':
          return actions.expandAll();
        case 'collapse-all':
          return actions.collapseAll();
        case 'toggle-theme':
          return actions.toggleTheme();
        case 'find':
          if (getState().tab === 'text') editor()?.openSearch();
          else searchRef.current?.focus();
          return;
      }
    };
    offs.push(window.api.onMenu(onMenu));
    offs.push(window.api.onOpenFile((f) => void actions.openFile(f)));

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMedia = (): void => setState((st) => ({ settings: st.settings && { ...st.settings } }));
    media.addEventListener('change', onMedia);
    offs.push(() => media.removeEventListener('change', onMedia));

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && getState().job?.shown) {
        e.preventDefault();
        actions.cancelJob();
      }
    };
    window.addEventListener('keydown', onKey);
    offs.push(() => window.removeEventListener('keydown', onKey));

    if (window.api.isE2E) {
      (window as unknown as Record<string, unknown>).__jsonlens = { getState, setState, actions };
    }
    return () => {
      disposed = true;
      offs.forEach((f) => f());
    };
  }, []);

  // drag & drop anywhere
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) void actions.dropFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (!ready) return <div className={s.boot}>{APP_NAME}</div>;

  return (
    <div className={s.app}>
      <Toolbar searchRef={searchRef} />
      <Tabs />
      <main className={s.content}>
        <div className={s.pane} hidden={tab !== 'text'} role="tabpanel" aria-label="Text">
          <TextTab />
        </div>
        <div className={s.pane} hidden={tab !== 'viewer'} role="tabpanel" aria-label="Viewer">
          {hasDoc ? <SplitView /> : <EmptyState where="viewer" />}
        </div>
        <LoaderOverlay />
        {dragging && (
          <div className={s.dropZone} aria-hidden>
            Drop a .json, .ndjson, .txt or .log file
          </div>
        )}
      </main>
      <StatusBar />
      <Toasts />
      <ContextMenu />
      <CsvExportDialog />
    </div>
  );
}
