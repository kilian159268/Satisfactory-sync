/**
 * Einziger Verdrahtungspunkt der Sync-Engine (Besitz: Kern-Agent).
 * index.ts ruft nur `createBackend(context)` auf.
 *
 * `SCHICHTWECHSEL_STUB=1` → StubBackend mit Testdaten (UI ohne Server/Spiel).
 */
import { existsSync } from 'node:fs';
import { app, safeStorage } from 'electron';
import type { BackendContext, LauncherBackend } from './backend';
import { consoleLogger, nodeFileSystem, runCommand, systemClock } from './node-ports';
import { loadMapGenerator, loadSteamCloudDetector } from './optional-modules';
import { tasklistProbe } from './platform/game-process';
import type { SecretCipher } from './ports';
import { StubBackend } from './stub-backend';
import { SyncEngine } from './sync/engine';

const electronCipher: SecretCipher = {
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: async (plain) => new Uint8Array(await safeStorage.encryptStringAsync(plain)),
  decrypt: async (data) => (await safeStorage.decryptStringAsync(Buffer.from(data))).result,
};

/** Lädt optionale Module (Karte, Cloud) erst beim Start und reicht sie an die Engine. */
class LazyEngineBackend extends SyncEngine {
  constructor(
    private readonly ready: Promise<void>,
    deps: ConstructorParameters<typeof SyncEngine>[0],
  ) {
    super(deps);
  }

  override async start(): Promise<void> {
    await this.ready;
    await super.start();
  }
}

export function createBackend(context: BackendContext): LauncherBackend {
  if (process.env.SCHICHTWECHSEL_STUB === '1') return new StubBackend();

  const deps: ConstructorParameters<typeof SyncEngine>[0] = {
    userDataDir: context.userDataDir,
    fs: nodeFileSystem,
    clock: systemClock,
    fetch: (input, init) => fetch(input, init),
    run: runCommand,
    probeGame: tasklistProbe(runCommand),
    cipher: electronCipher,
    env: {
      localAppData: process.env.LOCALAPPDATA ?? null,
      programData: process.env.PROGRAMDATA ?? null,
      driveRoots: windowsDriveRoots(),
    },
    openExternal: (url) => context.openExternal(url),
    writeClipboard: (text) => context.writeClipboard(text),
    logger: consoleLogger,
    setAutostart: (enabled) => {
      app.setLoginItemSettings({ openAtLogin: enabled });
    },
  };
  const ready = Promise.all([loadMapGenerator(), loadSteamCloudDetector()]).then(([map, cloud]) => {
    if (map !== undefined) deps.mapGenerator = map;
    if (cloud !== undefined) deps.detectSteamCloudEnabled = cloud;
  });
  return new LazyEngineBackend(ready, deps);
}

/** Vorhandene Laufwerke C: bis Z: (nur Windows), für die Suche nach Epic-Spielordnern. */
function windowsDriveRoots(): string[] {
  if (process.platform !== 'win32') return [];
  const roots: string[] = [];
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}
