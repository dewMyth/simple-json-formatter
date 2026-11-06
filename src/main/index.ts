import { join, normalize, resolve, extname, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { APP_HOST, APP_NAME, APP_SCHEME } from '@shared/constants';
import type { MenuCommand, OpenedFile } from '@shared/types';
import { applyNativeTheme, authorizeFile, registerIpc, resolveFileToken } from './ipc';
import { clearRecentFiles, getSettings, getWindowState, setWindowState } from './store';

// Large fixtures (200 MB) need more than V8's default old-space limit.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
app.setName(APP_NAME);

const isE2E = process.env.JSONLENS_E2E === '1';
if (isE2E && process.env.JSONLENS_USER_DATA) app.setPath('userData', process.env.JSONLENS_USER_DATA);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
const pendingFiles: OpenedFile[] = [];
let rendererReady = false;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function registerAppProtocol(): void {
  const rendererRoot = resolve(join(__dirname, '../renderer'));
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname.startsWith('/__file/')) {
      const path = resolveFileToken(url.pathname.slice('/__file/'.length));
      if (!path) return new Response('Not found', { status: 404, headers: cors });
      const res = await net.fetch(pathToFileURL(path).toString());
      const size = statSync(path).size;
      return new Response(res.body, {
        headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      });
    }
    // Static renderer bundle (production).
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = normalize(join(rendererRoot, rel));
    if (!file.startsWith(rendererRoot + sep) || !existsSync(file)) {
      return new Response('Not found', { status: 404 });
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    return new Response(res.body, {
      headers: { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' },
    });
  });
}

function send(cmd: MenuCommand): void {
  mainWindow?.webContents.send('menu', cmd);
}

async function openPathInApp(path: string): Promise<void> {
  const file = await authorizeFile(path);
  if (!file) return;
  if (mainWindow && rendererReady) mainWindow.webContents.send('file:open', file);
  else pendingFiles.push(file);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const recent = getSettings().recentFiles;
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        {
          label: 'Open Recent',
          submenu: [
            ...recent.map((p) => ({ label: p, click: () => void openPathInApp(p) })),
            ...(recent.length ? [{ type: 'separator' as const }] : []),
            {
              label: 'Clear Recent',
              enabled: recent.length > 0,
              click: () => {
                clearRecentFiles();
                app.clearRecentDocuments();
                buildMenu();
              },
            },
          ],
        },
        { type: 'separator' },
        { label: 'Save Formatted JSON…', accelerator: 'CmdOrCtrl+S', click: () => send('save-json') },
        { label: 'Export CSV…', accelerator: 'CmdOrCtrl+E', click: () => send('export-csv') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Paste && Format', accelerator: 'CmdOrCtrl+Shift+V', click: () => send('paste-format') },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Text', accelerator: 'CmdOrCtrl+1', click: () => send('tab-text') },
        { label: 'Viewer', accelerator: 'CmdOrCtrl+2', click: () => send('tab-viewer') },
        { type: 'separator' },
        { label: 'Expand All', click: () => send('expand-all') },
        { label: 'Collapse All', click: () => send('collapse-all') },
        { type: 'separator' },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('toggle-theme') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const state = getWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: isE2E ? ['--jsonlens-e2e'] : [],
    },
  });
  if (state.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const saveState = (): void => {
    if (!mainWindow) return;
    const b = mainWindow.getNormalBounds();
    setWindowState({ ...b, maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('close', saveState);
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  // No remote content: block navigation and new windows; open external links in the browser.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? `${APP_SCHEME}://`)) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  }
}

function filesFromArgv(argv: string[]): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-'))
    .map((a) => resolve(a))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

// macOS: double-click / drag onto the dock icon. May fire before 'ready'.
app.on('open-file', (e, path) => {
  e.preventDefault();
  void openPathInApp(path);
});

const gotLock = isE2E || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    for (const p of filesFromArgv(argv)) void openPathInApp(p);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    applyNativeTheme(getSettings().theme);
    registerAppProtocol();
    registerIpc(buildMenu);
    ipcMain.handle('app:pendingFiles', () => {
      rendererReady = true;
      return pendingFiles.splice(0);
    });
    buildMenu();
    for (const p of filesFromArgv(process.argv)) await openPathInApp(p);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
