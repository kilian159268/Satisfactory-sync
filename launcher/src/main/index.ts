/**
 * App-Start: Single-Instance, Fenster, Sicherheit, app://-Protokoll, IPC. Besitz: Fundament.
 * Die Sync-Engine wird ausschließlich über `createBackend()` eingebunden.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, net, protocol, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { LauncherBackend } from './backend';
import { createBackend } from './create-backend';
import { registerIpcHandlers } from './ipc-handlers';
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  PROD_CSP,
  devCsp,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  mimeTypeFor,
  resolveAppFile,
} from './security';

const APP_ID = 'de.v3in.sync';
const BACKGROUND = '#141416';

/** Von electron-vite nur bei `npm run dev` gesetzt. */
const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererRoot = join(__dirname, '../renderer');

let mainWindow: BrowserWindow | null = null;
let backend: LauncherBackend | null = null;
let disposeIpc: (() => void) | null = null;

// Muss vor `ready` passieren.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

async function openExternalSafe(url: string): Promise<boolean> {
  if (!isAllowedExternalUrl(url)) {
    console.warn(`[security] openExternal abgelehnt: ${url}`);
    return false;
  }
  await shell.openExternal(url);
  return true;
}

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(rendererRoot, request.url);
    if (file === null) return new Response('Nicht gefunden', { status: 404 });
    const upstream = await net.fetch(pathToFileURL(file).toString());
    if (!upstream.ok) return new Response('Nicht gefunden', { status: 404 });
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': mimeTypeFor(file),
        'Content-Security-Policy': PROD_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      },
    });
  });
}

function hardenSession(): void {
  const ses = session.defaultSession;
  // Keine Berechtigungen (Kamera, Benachrichtigungen, …) für den Renderer.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  if (devServerUrl !== undefined) {
    const csp = devCsp(devServerUrl);
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
      });
    });
  }
}

// Gilt für alle WebContents: keine Navigation, keine neuen Fenster, keine <webview>.
app.on('web-contents-created', (_event, contents) => {
  // Die UI ist eine Single-Page-App: jede Navigation wird blockiert (loadURL/reload sind nicht betroffen).
  contents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, devServerUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url);
    return { action: 'deny' };
  });
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 820,
    minHeight: 540,
    frame: false,
    show: false,
    backgroundColor: BACKGROUND,
    title: 'V3in-sync',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(devServerUrl ?? APP_ENTRY_URL);
  return win;
}

function focusMainWindow(): void {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Auto-Update über GitHub Releases (Plan 9). Nur im installierten Build. */
function startAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.logger = console;
  autoUpdater.autoInstallOnAppQuit = true; // installiert erst beim Beenden, nach backend.dispose()
  autoUpdater
    .checkForUpdatesAndNotify({
      title: 'Update bereit',
      body: 'V3in-sync {version} wird beim nächsten Beenden installiert.',
    })
    .catch((error: unknown) => {
      console.error('[updater] Prüfung fehlgeschlagen', error);
    });
}

async function startApp(): Promise<void> {
  app.setAppUserModelId(APP_ID);
  hardenSession();
  if (devServerUrl === undefined) registerAppProtocol();

  backend = createBackend({
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    openExternal: openExternalSafe,
    writeClipboard: (text) => clipboard.writeText(text),
  });
  disposeIpc = registerIpcHandlers({ backend, getWindow: () => mainWindow, devServerUrl });
  mainWindow = createWindow();
  startAutoUpdate();
  await backend.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.on('window-all-closed', () => {
    // Tray-Verhalten (Plan Kapitel 10) folgt; bis dahin beendet das Schließen die App.
    app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || backend === null) return;
    // Backend sauber beenden (Journal sichern), dann wirklich beenden.
    event.preventDefault();
    quitting = true;
    const current = backend;
    disposeIpc?.();
    disposeIpc = null;
    void current
      .dispose()
      .catch((error: unknown) => {
        console.error('[main] dispose fehlgeschlagen', error);
      })
      .finally(() => {
        backend = null;
        app.quit();
      });
  });

  app
    .whenReady()
    .then(startApp)
    .catch((error: unknown) => {
      console.error('[main] Start fehlgeschlagen', error);
      app.quit();
    });
}
