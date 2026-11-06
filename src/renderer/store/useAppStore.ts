import { create } from 'zustand';
import type { LoadedPayload, SanitizeError, SearchOptions, Settings, Stats, TreeIndex } from '@shared/types';
import { DEFAULT_SEARCH_OPTIONS } from '@worker/search';
import { computeVisible } from '../lib/visible';

export type Source =
  | { kind: 'text'; text: string }
  | { kind: 'file'; file: File; name: string; path?: string }
  | { kind: 'url'; url: string; name: string; path: string };

export interface DocState {
  index: TreeIndex;
  /** expanded bitset, mutated in place; `version` bumps on change */
  expanded: Uint8Array;
  visible: Int32Array;
  version: number;
  stats: Stats;
  fixes: string[];
  usedLossless: boolean;
  /** formatted text was not loaded into the editor */
  largeDoc: boolean;
  formattedBytes: number;
  name: string | null;
  path: string | null;
}

export interface JobState {
  id: number;
  stage: string;
  pct?: number;
  startedAt: number;
  /** shown after LOADER_DELAY_MS */
  shown: boolean;
  cancel: () => void;
}

export interface Toast {
  id: number;
  text: string;
  kind?: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export interface SearchState {
  query: string;
  opts: SearchOptions;
  ids: Int32Array;
  more: boolean;
  /** index into ids, -1 = none */
  current: number;
  running: boolean;
  error: string | null;
}

export interface AppState {
  settings: Settings | null;
  tab: 'text' | 'viewer';
  doc: DocState | null;
  selected: number;
  /** request for the tree to scroll a node into view */
  scrollTo: { id: number; seq: number } | null;
  error: SanitizeError | null;
  /** text pushed into the editor from outside (load results); `seq` bumps on each push */
  editorPush: { text: string; seq: number };
  job: JobState | null;
  search: SearchState;
  toasts: Toast[];
  contextMenu: { x: number; y: number; nodeId: number } | null;
  csvDialog: { fromNode: number } | null;
  fixesOpen: boolean;
  settingsOpen: boolean;
}

export const initialSearch: SearchState = {
  query: '',
  opts: DEFAULT_SEARCH_OPTIONS,
  ids: new Int32Array(0),
  more: false,
  current: -1,
  running: false,
  error: null,
};

export const useAppStore = create<AppState>(() => ({
  settings: null,
  tab: 'text',
  doc: null,
  selected: -1,
  scrollTo: null,
  error: null,
  editorPush: { text: '', seq: 0 },
  job: null,
  search: initialSearch,
  toasts: [],
  contextMenu: null,
  csvDialog: null,
  fixesOpen: false,
  settingsOpen: false,
}));

export const getState = useAppStore.getState;
export const setState = useAppStore.setState;

/** Builds a DocState from a load result. */
export function docFromPayload(
  p: LoadedPayload,
  expanded: Uint8Array,
  meta: { name: string | null; path: string | null },
): DocState {
  return {
    index: p.index,
    expanded,
    visible: computeVisible(p.index, expanded),
    version: 1,
    stats: p.stats,
    fixes: p.fixes,
    usedLossless: p.usedLossless,
    largeDoc: p.formatted === undefined,
    formattedBytes: p.formattedBytes,
    name: meta.name,
    path: meta.path,
  };
}

/** Call after mutating doc.expanded in place. */
export function refreshVisible(): void {
  const doc = getState().doc;
  if (!doc) return;
  setState({ doc: { ...doc, visible: computeVisible(doc.index, doc.expanded), version: doc.version + 1 } });
}

let toastSeq = 1;
export function toast(text: string, opts: Omit<Toast, 'id' | 'text'> = {}): void {
  const id = toastSeq++;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, ...opts }] }));
  setTimeout(() => dismissToast(id), opts.action ? 6000 : 3500);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
