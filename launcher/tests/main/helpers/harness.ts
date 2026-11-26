/** Baut eine SyncEngine mit simuliertem Dateisystem, Server, Uhr und Spielprozess. */
import { join, resolve } from 'node:path';
import type { Logger, SecretCipher } from '../../../src/main/ports';
import { SyncEngine, type EngineDeps, type EngineTimings } from '../../../src/main/sync/engine';
import type { AppState } from '../../../src/shared/ipc';
import { FakeClock } from './fake-clock';
import { FakeServer } from './fake-server';
import { MemoryFs } from './memory-fs';
import { buildSave, type SaveSpec } from './saves';

export const SESSION = 'Fabrik Nord';
export const STEAM_ID = '76561198000000001';

export const fakeCipher: SecretCipher = {
  isAvailable: () => Promise.resolve(true),
  encrypt: (plain) => Promise.resolve(new TextEncoder().encode(`enc:${plain}`)),
  decrypt: (data) => {
    const text = new TextDecoder().decode(data);
    if (!text.startsWith('enc:')) return Promise.reject(new Error('kaputt'));
    return Promise.resolve(text.slice(4));
  },
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const TEST_TIMINGS: Partial<EngineTimings> = {
  processPollMs: 1_000,
  processGraceMs: 2_000,
  savePollMs: 1_000,
  saveQuietMs: 5_000,
  gameStartTimeoutMs: 60_000,
  downloadRetryMs: 1_000,
};

export interface HarnessOptions {
  name?: string;
  clock?: FakeClock;
  server?: FakeServer;
  fs?: MemoryFs;
  /** Ordnername in userData (zwei Launcher auf einem simulierten Rechner). */
  userData?: string;
  /** Spiel startet von selbst, sobald der Launcher die URI öffnet. */
  autoStartGame?: boolean;
  /** Installierte Spielversion (Changelist); null = keine Installation simulieren. */
  installedBuild?: number | null;
  loggedIn?: boolean;
  deps?: Partial<EngineDeps>;
}

export class Harness {
  readonly clock: FakeClock;
  readonly server: FakeServer;
  readonly fs: MemoryFs;
  readonly name: string;
  readonly userData: string;
  readonly saveDir: string;
  readonly opened: string[] = [];
  readonly states: AppState[] = [];
  gameRunning = false;
  engine: SyncEngine;
  private readonly options: HarnessOptions;

  constructor(options: HarnessOptions = {}) {
    this.options = options;
    this.name = options.name ?? 'Anna';
    this.clock = options.clock ?? new FakeClock();
    this.server = options.server ?? new FakeServer(this.clock);
    this.fs = options.fs ?? new MemoryFs(() => this.clock.now());
    this.userData = resolve('/sim', options.userData ?? `ud-${this.name}`);
    this.saveDir = resolve('/sim/local/FactoryGame/Saved/SaveGames', STEAM_ID);
    void this.fs.mkdir(this.saveDir);
    this.fs.put(
      join(this.userData, 'settings.json'),
      JSON.stringify({
        serverUrl: 'https://sync.test',
        platform: 'steam',
        saveDir: null,
        autostart: false,
      }),
    );
    if (options.loggedIn !== false) {
      const token = this.server.addUser(this.name);
      this.fs.put(join(this.userData, 'token.bin'), `enc:${token}`);
    }
    const build = options.installedBuild === undefined ? 400_000 : options.installedBuild;
    if (build !== null) {
      this.fs.put(
        resolve(
          '/sim/steam/steamapps/common/Satisfactory/FactoryGame/Binaries/Win64/FactoryGameSteam-Win64-Shipping.version',
        ),
        JSON.stringify({ MajorVersion: 5, Changelist: build }),
      );
    }
    this.engine = this.createEngine();
  }

  createEngine(): SyncEngine {
    const deps: EngineDeps = {
      userDataDir: this.userData,
      fs: this.fs,
      clock: this.clock,
      fetch: this.server.fetch,
      run: (file, args) => {
        if (file === 'reg' && args[1] === 'HKCU\\Software\\Valve\\Steam') {
          return Promise.resolve(
            `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${resolve('/sim/steam')}\r\n`,
          );
        }
        return Promise.reject(new Error('nicht gefunden'));
      },
      probeGame: () => Promise.resolve(this.gameRunning),
      cipher: fakeCipher,
      env: { localAppData: resolve('/sim/local'), programData: resolve('/sim/programdata') },
      openExternal: (url) => {
        this.opened.push(url);
        if (this.options.autoStartGame !== false) this.gameRunning = true;
        return Promise.resolve(true);
      },
      writeClipboard: () => Promise.resolve(),
      logger: silentLogger,
      randomId: (() => {
        let n = 0;
        return () => `${this.name}-id-${++n}`;
      })(),
      timings: TEST_TIMINGS,
      ...this.options.deps,
    };
    const engine = new SyncEngine(deps);
    engine.onStateChange((s) => this.states.push(s));
    return engine;
  }

  /** Simulierter Absturz: neue Engine auf denselben Dateien (alte wird verworfen). */
  async crashAndRestart(): Promise<void> {
    await this.engine.dispose();
    this.engine = this.createEngine();
    await this.start();
  }

  async start(): Promise<void> {
    const p = this.engine.start();
    await this.clock.advance(0);
    await p;
  }

  get state(): AppState {
    return this.states.at(-1) ?? (undefined as unknown as AppState);
  }

  async snapshot(): Promise<AppState> {
    return this.engine.getState();
  }

  phases(): string[] {
    const out: string[] = [];
    for (const s of this.states) if (out.at(-1) !== s.phase) out.push(s.phase);
    return out;
  }

  /** Save im Save-Ordner anlegen (wie das Spiel). */
  writeSave(
    file: string,
    spec: Partial<SaveSpec> & { playSeconds: number },
    mtimeMs = this.clock.now(),
  ): Uint8Array {
    const data = buildSave({ sessionName: SESSION, ...spec });
    this.fs.put(join(this.saveDir, file), data, mtimeMs);
    return data;
  }

  saveFiles(): string[] {
    return this.fs.list(this.saveDir).map((p) => p.slice(this.saveDir.length + 1));
  }

  /** Spielen drücken, bis das Spiel läuft. */
  async playUntilHosting(): Promise<void> {
    const p = this.engine.play();
    await this.clock.advance(2_000);
    const r = await p;
    if (!r.ok) throw new Error(`play fehlgeschlagen: ${r.error}`);
  }

  async advance(ms: number): Promise<void> {
    await this.clock.advance(ms);
  }

  /** Spiel schließen und warten, bis der Abschluss durch ist. */
  async closeGame(): Promise<void> {
    this.gameRunning = false;
    await this.clock.advance(4_000);
    await this.engine.idle();
    await this.clock.advance(0);
  }

  journalFile(): unknown {
    const path = join(this.userData, 'journal.json');
    return this.fs.has(path) ? JSON.parse(this.fs.text(path)) : null;
  }
}

/** Server mit einem Head-Stand. */
export function seedHead(
  server: FakeServer,
  playSeconds = 1_000,
  extra: Partial<SaveSpec> = {},
): ReturnType<FakeServer['seedVersion']> {
  return server.seedVersion(
    buildSave({ sessionName: SESSION, playSeconds, body: `head-${playSeconds}`, ...extra }),
  );
}
