import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { json } from '@codemirror/lang-json';
import { tags as t } from '@lezer/highlight';
import type { SanitizeError } from '@shared/types';
import { LINT_MAX_BYTES } from '@shared/constants';
import { getState, useAppStore } from '../../store/useAppStore';
import { registerEditor } from '../../lib/editorBridge';
import { client, loadText, settings } from '../../lib/actions';
import { CancelledError } from '../../lib/workerClient';
import s from '../../styles/ui.module.css';

const highlightStyle = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--tok-key)' },
  { tag: t.string, color: 'var(--tok-string)' },
  { tag: t.number, color: 'var(--tok-number)' },
  { tag: t.bool, color: 'var(--tok-bool)' },
  { tag: t.null, color: 'var(--tok-null)' },
  { tag: [t.punctuation, t.separator, t.brace, t.squareBracket], color: 'var(--tok-punct)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-scroller': {
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: '12.5px',
    lineHeight: '1.55',
  },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-faint)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--row-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--row-hover)', color: 'var(--text-muted)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--row-selected) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--row-match)', outline: '1px solid var(--mark-bg)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--mark-bg)', color: 'var(--mark-text)' },
  '.cm-textfield, .cm-button': {
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    backgroundImage: 'none',
    borderRadius: '4px',
  },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: 'none', color: 'var(--text-muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
});

/** Linting runs JSON.parse in the worker (never on the UI thread), and only for documents ≤ 2 MB. */
const workerLinter = linter(
  async (view) => {
    if (view.state.doc.length === 0 || view.state.doc.length > LINT_MAX_BYTES) return [];
    if (getState().job) return [];
    try {
      const err = await client.call<SanitizeError | null>({ kind: 'lint', text: view.state.doc.toString() });
      if (!err) return [];
      const from = Math.min(err.offset, view.state.doc.length);
      const diag: Diagnostic = {
        from,
        to: Math.min(from + 1, view.state.doc.length),
        severity: 'error',
        message: err.message,
      };
      return [diag];
    } catch (e) {
      if (e instanceof CancelledError) return [];
      return [];
    }
  },
  { delay: 600 },
);

export function JsonEditor(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const push = useAppStore((st) => st.editorPush);
  const pendingRef = useRef<{ text: string; seq: number } | null>(null);
  const appliedRef = useRef(0);

  /** Applies text pushed into the editor that hasn't been applied yet. */
  const applyPending = (): void => {
    const view = viewRef.current;
    const p = pendingRef.current;
    if (!view || !p) return;
    pendingRef.current = null;
    appliedRef.current = p.seq;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: p.text },
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          search({ top: true }),
          json(),
          syntaxHighlighting(highlightStyle),
          lintGutter(),
          workerLinter,
          theme,
          EditorView.contentAttributes.of({ 'aria-label': 'JSON text', 'data-testid': 'editor' }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
          EditorView.domEventHandlers({
            paste(event, v) {
              // Smart format on paste when the paste replaces the whole document.
              if (!settings().autoFormatOnPaste) return false;
              const sel = v.state.selection.main;
              const whole = v.state.doc.length === 0 || (sel.from === 0 && sel.to === v.state.doc.length);
              if (!whole) return false;
              const text = event.clipboardData?.getData('text/plain') ?? '';
              if (!text.trim()) return false;
              event.preventDefault();
              void loadText(text);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    registerEditor({
      getText: () => pendingRef.current?.text ?? view.state.doc.toString(),
      length: () => pendingRef.current?.text.length ?? view.state.doc.length,
      jumpTo: (line, column) => {
        applyPending();
        const doc = view.state.doc;
        const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
        const pos = Math.min(l.from + Math.max(0, column - 1), l.to);
        view.dispatch({
          selection: { anchor: pos },
          scrollIntoView: true,
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        view.focus();
      },
      openSearch: () => {
        openSearchPanel(view);
      },
      focus: () => view.focus(),
    });
    return () => {
      registerEditor(null);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Text pushed by a load is applied in its own idle-time task, after the tree has rendered. Splitting a
  // multi-MB document into lines and the first syntax parse are the most expensive UI-thread work in a
  // load, so they must not share a task with the tree render.
  // It is applied even while the Text tab is hidden: applying it to a hidden editor is cheap, whereas
  // applying it right after the editor becomes visible forces a full layout (~0.7 s for medium.json).
  useEffect(() => {
    pendingRef.current = push.seq > appliedRef.current ? push : null;
    if (!pendingRef.current) return;
    const handle = requestIdleCallback(applyPending, { timeout: 250 });
    return () => cancelIdleCallback(handle);
  }, [push]);

  return <div ref={host} className={s.editor} />;
}
