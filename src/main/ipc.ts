import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenedFile, Settings, ThemePref } from '@shared/types';
import { APP_HOST, APP_SCHEME, OPENABLE_EXTENSIONS } from '@shared/constants';
import { addRecentFile, getSettings, setSettings } from './store';
import { attachExportPort, cancelExport, registerExport } from './exportWriter';

/** token → absolute path for files the user has chosen to open. Only these are served to the renderer. */
const authorized = new Map<string, string>();
const tokenByPath = new Map<string, string>();

export function resolveFileToken(token: string): string | undefined {
  return authorized.get(token);
}

function isAuthorizedPath(path: string): boolean {
  return tokenByPath.has(path);
}

export async function authorizeFile(path: string): Promise<OpenedFile | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    let token = tokenByPath.get(path);
    if (!token) {
      token = randomUUID();
      authorized.set(token, path);
      tokenByPath.set(path, token);
    }
    return {
      path,
      name: basename(path),
      size: s.size,
      url: `${APP_SCHEME}://${APP_HOST}/__file/${token}`,
    };
  } catch {
    return null;
  }
}

export function applyNativeTheme(theme: ThemePref): void {
  nativeTheme.themeSource = theme;
}

export function registerIpc(onRecentChanged: () => void): void {
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const next = setSettings(patch);
    if (patch.theme) applyNativeTheme(patch.theme);
    if (patch.recentFiles) onRecentChanged();
    return next;
  });

  ipcMain.handle('file:openDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        { name: 'JSON and text', extensions: OPENABLE_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return authorizeFile(res.filePaths[0]);
  });

  ipcMain.handle('file:openPath', (_e, path: string) => authorizeFile(path));

  ipcMain.handle('file:read', async (_e, path: string) => {
    if (!isAuthorizedPath(path)) throw new Error('File not authorised');
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('file:addRecent', (_e, path: string) => {
    addRecentFile(path);
    onRecentChanged();
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text));

  ipcMain.handle('export:choose', async (e, kind: 'csv' | 'json', suggestedName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.SaveDialogOptions = {
      defaultPath: suggestedName,
      filters:
        kind === 'csv' ? [{ name: 'CSV', extensions: ['csv'] }] : [{ name: 'JSON', extensions: ['json'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    return { path: res.filePath, exportId: registerExport(res.filePath, e.sender) };
  });

  ipcMain.on('export:port', (e, payload: { exportId: number }) => {
    const port = e.ports[0];
    if (port) attachExportPort(payload.exportId, port);
  });

  ipcMain.handle('export:cancel', (_e, exportId: number) => cancelExport(exportId));

  ipcMain.handle('shell:showInFolder', (_e, path: string) => shell.showItemInFolder(path));

  ipcMain.on('theme:set', (_e, theme: ThemePref) => applyNativeTheme(theme));
}
