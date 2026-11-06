import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { JsonLensApi, MenuCommand, OpenedFile, Settings, ThemePref } from '../shared/types';

const PORT_MESSAGE = 'jsonlens:export-port';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: JsonLensApi = {
  platform: process.platform,
  isE2E: process.argv.includes('--jsonlens-e2e'),
  getPendingFiles: () => ipcRenderer.invoke('app:pendingFiles'),
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openFileDialog: () => ipcRenderer.invoke('file:openDialog'),
  openPath: (path) => ipcRenderer.invoke('file:openPath', path),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  addRecent: (path) => ipcRenderer.invoke('file:addRecent', path),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  chooseSavePath: (kind, suggestedName) => ipcRenderer.invoke('export:choose', kind, suggestedName),
  openExportPort: (exportId) => {
    // MessagePorts can't cross contextBridge. Send one end to main, and hand the other to the page
    // through window.postMessage, which can transfer ports (see renderer/lib/exportPort.ts).
    const { port1, port2 } = new MessageChannel();
    ipcRenderer.postMessage('export:port', { exportId }, [port1]);
    window.postMessage({ type: PORT_MESSAGE, exportId }, '*', [port2]);
  },
  cancelExport: (exportId) => ipcRenderer.invoke('export:cancel', exportId),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),
  setNativeTheme: (theme: ThemePref) => ipcRenderer.send('theme:set', theme),
  onMenu: (cb) => on<MenuCommand>('menu', cb),
  onOpenFile: (cb) => on<OpenedFile>('file:open', cb),
  onExportProgress: (cb) => on<{ exportId: number; bytes: number }>('export:progress', cb),
};

contextBridge.exposeInMainWorld('api', api);
