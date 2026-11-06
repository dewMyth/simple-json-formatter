import Store from 'electron-store';
import type { Settings } from '@shared/types';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

interface Schema {
  settings: Settings;
  window: WindowState;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  lastTab: 'text',
  indent: 2,
  sortKeys: false,
  autoFormatOnPaste: true,
  expandNested: false,
  bigNumbers: true,
  editorMaxMB: 25,
  treeWidth: 0.6,
  csv: {},
  recentFiles: [],
};

let store: Store<Schema> | null = null;

function getStore(): Store<Schema> {
  if (!store) {
    store = new Store<Schema>({
      name: 'settings',
      defaults: { settings: DEFAULT_SETTINGS, window: { width: 1280, height: 820 } },
    });
  }
  return store;
}

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...getStore().get('settings') };
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  getStore().set('settings', next);
  return next;
}

export function getWindowState(): WindowState {
  return getStore().get('window');
}

export function setWindowState(state: WindowState): void {
  getStore().set('window', state);
}

export function addRecentFile(path: string): string[] {
  const recent = [path, ...getSettings().recentFiles.filter((p) => p !== path)].slice(0, 10);
  setSettings({ recentFiles: recent });
  return recent;
}

export function clearRecentFiles(): void {
  setSettings({ recentFiles: [] });
}
