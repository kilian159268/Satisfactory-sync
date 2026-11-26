/**
 * Sync-Engine: setzt API-Client, Journal, Zustandsmaschine, Pfade, Watcher und Prozess-Wächter
 * zum `LauncherBackend` zusammen (Plan 4, 6, 7, 8). Alle Abhängigkeiten werden injiziert.
 *
 * Ablauf-Regeln:
 * - Phasenwechsel nur über `go(event)` → Übergangstabelle (state-machine.ts).
 * - Jede Phase einer Host-Session steht im Journal, bevor dort etwas passiert.
 * - Aktionen, die Phasen wechseln, laufen nacheinander (`serial`).
 * - Spielstände werden nie gelöscht: Quarantäne/Archiv per Verschieben, und ins Archiv nur, was
 *   der Server per SHA-256 bestätigt hat.
 */
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type {
  HostInfo,
  LeaseGrant,
  UploadResult,
  Version,
  WorldResponse,
} from '../../shared/api-types';
import {
  MapDataSchema,
  type ActionResult,
  type AppState,
  type MapData,
  type Phase,
  type Platform,
  type RedeemInviteInput,
  type Settings,
  type SettingsPatch,
  type VersionView,
} from '../../shared/ipc';
import {
  ApiClient,
  ApiError,
  HashMismatchError,
  isRetryable,
  NetworkError,
} from '../api/api-client';
import type { LauncherBackend, StateListener, Unsubscribe } from '../backend';
import { sha256File } from '../files';
import {
  GAME_START_TIMEOUT_MS,
  HEARTBEAT_MS,
  PRESENCE_MS,
  PROCESS_GONE_GRACE_MS,
  PROCESS_POLL_MS,
  RETRY_BACKOFF_SEC,
  SAVE_POLL_MS,
  SAVE_QUIET_MS,
} from '../game-assumptions';
import {
  chooseSaveDir,
  detectInstalledGames,
  findSaveDirs,
  readInstalledBuild,
  suggestPlatform,
  type InstalledGames,
  type PlatformEnv,
} from '../platform/detect';
import { GameProcessWatcher, launchUriFor, type ProcessProbe } from '../platform/game-process';
import {
  every,
  sleep,
  type Cancel,
  type Clock,
  type CommandRunner,
  type FetchFn,
  type FileSystem,
  type Logger,
  type SecretCipher,
} from '../ports';
import {
  LauncherDirs,
  moveFilesTo,
  placeSyncSave,
  scanSaves,
  scanSessionSaves,
  sortNewestFirst,
  type SessionSave,
} from '../saves/save-files';
import { readSaveHeader } from '../saves/save-header';
import { SaveWatcher } from '../saves/save-watcher';
import { SettingsStore } from '../storage/settings-store';
import { TokenStore } from '../storage/token-store';
import { JournalStore, type Journal, type PendingUpload } from './journal';
import { recoveryFor, SESSION_PHASES, transition, type EngineEvent } from './state-machine';
import { clockTime, hostView, toCrewView, toVersionView } from './views';

export interface EngineTimings {
  heartbeatMs: number;
  presenceMs: number;
  savePollMs: number;
  saveQuietMs: number;
  processPollMs: number;
  processGraceMs: number;
  gameStartTimeoutMs: number;
  retryBackoffSec: readonly number[];
  /** Versuche je Download (Hash falsch / Netz weg). */
  downloadAttempts: number;
  /** Pause zwischen Download-Versuchen. */
  downloadRetryMs: number;
  /** Versuche je Upload innerhalb eines Durchgangs (Hash falsch beim Server). */
  uploadAttempts: number;
}

export const DEFAULT_TIMINGS: EngineTimings = {
  heartbeatMs: HEARTBEAT_MS,
  presenceMs: PRESENCE_MS,
  savePollMs: SAVE_POLL_MS,
  saveQuietMs: SAVE_QUIET_MS,
  processPollMs: PROCESS_POLL_MS,
  processGraceMs: PROCESS_GONE_GRACE_MS,
  gameStartTimeoutMs: GAME_START_TIMEOUT_MS,
  retryBackoffSec: RETRY_BACKOFF_SEC,
  downloadAttempts: 3,
  downloadRetryMs: 3_000,
  uploadAttempts: 3,
};

export interface EngineDeps {
  userDataDir: string;
  fs: FileSystem;
  clock: Clock;
  fetch: FetchFn;
  /** Für `reg query` (Steam-Erkennung). */
  run: CommandRunner;
  /** Läuft Satisfactory gerade? */
  probeGame: ProcessProbe;
  cipher: SecretCipher;
  env: PlatformEnv;
  openExternal(url: string): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;
  logger: Logger;
  /** Autostart umsetzen (Electron `setLoginItemSettings`); optional. */
  setAutostart?: (enabled: boolean) => void;
  /** Karte aus einem Save erzeugen (src/main/map, läuft im Worker); optional. */
  mapGenerator?: (savePath: string) => Promise<MapData>;
  /** Steam-Cloud für Satisfactory an? (src/main/cloud); optional. */
  detectSteamCloudEnabled?: (steamRoot: string) => Promise<boolean | null>;
  randomId?: () => string;
  timings?: Partial<EngineTimings>;
}

/** Erwartbarer Abbruch eines Ablaufs mit deutscher Meldung. */
class FlowError extends Error {}

/** Upload konnte gerade nicht abgeschlossen werden; später mit gleichem Key erneut. */
class RetryLater extends Error {}

const TEXT = {
  verbinden: 'Verbinde mit dem Server …',
  anmelden: 'Bitte mit deinem Einladungscode anmelden.',
  lease_holen: 'Hostrecht anfragen …',
  herunterladen: 'Spielstand herunterladen …',
  vorbereiten: 'Spielstand vorbereiten …',
  spiel_starten: 'Satisfactory wird gestartet …',
  hosten: 'Du hostest. Jeder Save wird automatisch hochgeladen.',
  beenden: 'Spiel beendet – neuesten Spielstand suchen …',
  hochladen: 'Spielstand hochladen …',
  lease_freigeben: 'Hostrecht freigeben …',
  aufraeumen: 'Aufräumen …',
  wartet_auf_netz: 'Keine Verbindung. Der Spielstand bleibt auf diesem PC, bis er hochgeladen ist.',
  offline: 'Server nicht erreichbar.',
  serverDown:
    'Server nicht erreichbar – Host werden geht gerade nicht. „Nur Spiel starten“ funktioniert.',
  gameRunning: 'Satisfactory läuft schon. Schließ das Spiel zuerst, dann kannst du hosten.',
  busy: 'Es läuft bereits ein Vorgang.',
  diskFull: 'Die Festplatte des Servers ist voll. Der Spielstand bleibt auf diesem PC.',
  tooNew:
    'Der Spielstand ist mit einer neueren Spielversion gespeichert. Bitte Satisfactory updaten.',
  leaseLost:
    'Hostrecht verloren. Weitere Saves werden nur als Konfliktkopie gespeichert, nichts wird überschrieben.',
  heartbeatOffline:
    'Keine Verbindung zum Server. Spiel weiter und speichere – nach 2 Minuten ohne Verbindung kann ein anderer Host werden.',
  noPlatform: 'Bitte in den Einstellungen Steam oder Epic wählen.',
  noSaveDir: 'Spielstand-Ordner nicht gefunden. Bitte in den Einstellungen wählen.',
  steamCloud:
    'Steam-Cloud ist für Satisfactory noch an. Bitte in Steam abschalten (Eigenschaften → Allgemein).',
} as const;

const CONFLICT_REASONS_LOSING_LEASE = new Set([
  'no_lease',
  'stale_token',
  'lease_expired',
  'base_mismatch',
]);

function initialState(): AppState {
  return {
    phase: 'verbinden',
    progress: null,
    message: TEXT.verbinden,
    error: null,
    gameRunning: false,
    host: null,
    head: null,
    crew: [],
    connection: { online: false, latencyMs: null, nextRetryInSec: null },
    me: null,
    lastSaveAgeSec: null,
    serverDiskFull: false,
    sessionCodeAvailable: false,
  };
}

export class SyncEngine implements LauncherBackend {
  private readonly fs: FileSystem;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly t: EngineTimings;
  private readonly dirs: LauncherDirs;
  private readonly settings: SettingsStore;
  private readonly tokens: TokenStore;
  private readonly journals: JournalStore;
  private readonly api: ApiClient;
  private readonly game: GameProcessWatcher;
  private readonly randomId: () => string;

  private state: AppState = initialState();
  private readonly listeners = new Set<StateListener>();
  private journal: Journal | null = null;
  private world: WorldResponse | null = null;
  private versionsCache: Version[] = [];
  private installed: InstalledGames | null = null;
  private steamCloudOn = false;
  private disposed = false;

  private queue: Promise<void> = Promise.resolve();
  private busy = false;
  private stopPresence: Cancel | null = null;
  private stopHeartbeat: Cancel | null = null;
  private stopRetry: Cancel | null = null;
  private stopUploadRetry: Cancel | null = null;
  private saveWatcher: SaveWatcher | null = null;
  private retryAttempt = 0;
  private gameWaiters: ((running: boolean) => void)[] = [];
  private uploadChain: Promise<void> = Promise.resolve();
  private nextCandidate: SessionSave | null = null;

  constructor(private readonly deps: EngineDeps) {
    this.fs = deps.fs;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.dirs = new LauncherDirs(deps.userDataDir);
    this.settings = new SettingsStore(deps.fs, deps.userDataDir);
    this.tokens = new TokenStore(deps.fs, deps.cipher, deps.userDataDir, deps.logger);
    this.journals = new JournalStore(deps.fs, deps.userDataDir);
    this.randomId = deps.randomId ?? (() => randomUUID());
    this.api = new ApiClient({
      baseUrl: 'https://invalid.local',
      fetch: deps.fetch,
      clock: deps.clock,
      onLatency: (ms) => {
        this.patch({
          connection: { online: true, latencyMs: Math.round(ms), nextRetryInSec: null },
        });
      },
    });
    this.game = new GameProcessWatcher(
      deps.probeGame,
      deps.clock,
      this.t.processPollMs,
      this.t.processGraceMs,
    );
  }

  // ================================================================ LauncherBackend

  async start(): Promise<void> {
    const settings = await this.settings.load();
    this.api.setBaseUrl(settings.serverUrl);
    this.api.setToken(await this.tokens.load());
    this.journal = await this.journals.load();
    await this.detectPlatform();
    const running = await this.game.start();
    this.patch({ gameRunning: running });
    this.game.onChange((r) => {
      this.onGameChange(r);
    });
    await this.serial(() => this.connect());
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.game.stop();
    this.saveWatcher?.stop();
    for (const stop of [
      this.stopPresence,
      this.stopHeartbeat,
      this.stopRetry,
      this.stopUploadRetry,
    ])
      stop?.();
    this.listeners.clear();
    // Das Journal liegt bereits auf der Platte (jede Phase wird vorher geschrieben).
    return Promise.resolve();
  }

  getState(): Promise<AppState> {
    return Promise.resolve(this.state);
  }

  onStateChange(listener: StateListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async play(): Promise<ActionResult> {
    if (this.busy || this.state.phase !== 'bereit') {
      if (this.state.phase === 'offline' || this.state.phase === 'verbinden') {
        return { ok: false, error: TEXT.serverDown };
      }
      return { ok: false, error: TEXT.busy };
    }
    // Plan 4.1 Schritt 4 / Kapitel 8 „Spiel lief schon vor dem Launcher“.
    if (this.game.isRunning()) return { ok: false, error: TEXT.gameRunning };
    const platform = this.settings.get().platform;
    if (platform === null) return { ok: false, error: TEXT.noPlatform };
    // Sofort sperren (vor dem ersten await) – Doppelklick startet nur einen Ablauf.
    this.busy = true;
    let result: ActionResult = { ok: true };
    try {
      const saveDir = await this.resolveSaveDir(platform);
      if (saveDir === null) return { ok: false, error: TEXT.noSaveDir };
      await this.serial(async () => {
        try {
          result = await this.hostFlow(platform, saveDir);
        } catch (error) {
          result = { ok: false, error: this.describe(error) };
          throw error;
        }
      });
    } finally {
      this.busy = false;
    }
    return result;
  }

  async startGameOnly(): Promise<ActionResult> {
    if (this.game.isRunning()) return { ok: false, error: 'Das Spiel läuft bereits.' };
    const platform = this.settings.get().platform;
    if (platform === null) return { ok: false, error: TEXT.noPlatform };
    if (!(await this.deps.openExternal(launchUriFor(platform, this.installed?.epic?.appName)))) {
      return { ok: false, error: 'Satisfactory konnte nicht gestartet werden.' };
    }
    return { ok: true, message: 'Satisfactory wird gestartet.' };
  }

  async retryConnection(): Promise<ActionResult> {
    const phase = this.state.phase;
    if (phase === 'wartet_auf_netz') {
      this.cancelRetry();
      await this.serial(() => this.retryFinish());
      return { ok: true };
    }
    if (phase === 'offline' || phase === 'fehler' || phase === 'bereit' || phase === 'anmelden') {
      this.cancelRetry();
      await this.serial(async () => {
        this.go('CONNECT');
        await this.connect();
      });
      return { ok: true };
    }
    return { ok: false, error: TEXT.busy };
  }

  async redeemInvite(input: RedeemInviteInput): Promise<ActionResult> {
    const client = new ApiClient({
      baseUrl: input.serverUrl,
      fetch: this.deps.fetch,
      clock: this.clock,
    });
    let token: string;
    let name: string;
    try {
      const res = await client.redeem(input.code, input.name);
      token = res.token;
      name = res.name;
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, error: error.message };
      return { ok: false, error: 'Server nicht erreichbar. Adresse prüfen und erneut versuchen.' };
    }
    await this.tokens.save(token);
    await this.settings.update({ serverUrl: input.serverUrl });
    this.api.setBaseUrl(input.serverUrl);
    this.api.setToken(token);
    this.patch({ me: { name }, error: null });
    if (!SESSION_PHASES.has(this.state.phase)) {
      await this.serial(async () => {
        if (this.state.phase === 'anmelden') this.go('LOGGED_IN');
        else if (this.can('CONNECT')) this.go('CONNECT');
        await this.connect();
      });
    }
    return { ok: true, message: `Angemeldet als ${name}.` };
  }

  async listVersions(): Promise<VersionView[]> {
    try {
      this.versionsCache = await this.api.versions();
    } catch (error) {
      this.logger.warn('Verlauf nicht ladbar', error);
    }
    const headId = this.world?.head?.id ?? null;
    return this.versionsCache.map((v) => toVersionView(v, headId));
  }

  async restoreVersion(id: number): Promise<ActionResult> {
    if (this.state.phase !== 'bereit' || this.busy) {
      return { ok: false, error: 'Zurückholen geht nur, solange niemand hostet.' };
    }
    try {
      const version = await this.api.restore(id);
      await this.refreshServer();
      return { ok: true, message: `Stand ${version.label} ist wieder aktuell.` };
    } catch (error) {
      return { ok: false, error: this.describe(error) };
    }
  }

  async getMap(versionId: number): Promise<MapData | null> {
    try {
      return await this.api.getMap(versionId);
    } catch (error) {
      this.logger.warn('Karte nicht ladbar', error);
      return null;
    }
  }

  getSettings(): Promise<Settings> {
    return Promise.resolve(this.settings.get());
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const before = this.settings.get();
    const next = await this.settings.update(patch);
    if (patch.autostart !== undefined && patch.autostart !== before.autostart) {
      this.deps.setAutostart?.(patch.autostart);
    }
    if (next.serverUrl !== before.serverUrl) {
      this.api.setBaseUrl(next.serverUrl);
      // Eine laufende Session bleibt beim alten Server (Journal); sonst neu verbinden.
      if (!SESSION_PHASES.has(this.state.phase) && this.can('CONNECT')) {
        void this.serial(async () => {
          if (this.can('CONNECT')) this.go('CONNECT');
          await this.connect();
        });
      }
    }
    return next;
  }

  copySessionCode(): Promise<ActionResult> {
    // Plan Kapitel 10/14: ob es einen auslesbaren Beitrittscode gibt, ist ungeprüft → Knopf aus.
    return Promise.resolve({ ok: false, error: 'Kein Session-Code verfügbar.' });
  }

  /** Für Tests: wartet, bis alle eingereihten Abläufe fertig sind. */
  async idle(): Promise<void> {
    for (;;) {
      const q = this.queue;
      const u = this.uploadChain;
      await Promise.all([q, u]);
      if (q === this.queue && u === this.uploadChain) return;
    }
  }

  // ================================================================ Zustand

  private patch(partial: Partial<AppState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l(this.state);
  }

  private can(event: EngineEvent): boolean {
    try {
      transition(this.state.phase, event);
      return true;
    } catch {
      return false;
    }
  }

  /** Einziger Weg, die Phase zu ändern (Tabelle in state-machine.ts). */
  private go(event: EngineEvent, extra: Partial<AppState> = {}): Phase {
    const to = transition(this.state.phase, event);
    const message = to in TEXT ? TEXT[to as keyof typeof TEXT] : null;
    this.patch({ phase: to, progress: null, message, ...extra });
    return to;
  }

  /** Phase wechseln und – in einer Host-Session – vorher ins Journal schreiben. */
  private async goJournaled(event: EngineEvent, extra: Partial<AppState> = {}): Promise<void> {
    const to = transition(this.state.phase, event);
    if (this.journal !== null && SESSION_PHASES.has(to)) {
      await this.saveJournal({ phase: to });
    }
    this.go(event, extra);
  }

  private async saveJournal(changes: Partial<Journal>): Promise<void> {
    if (this.journal === null) return;
    this.journal = { ...this.journal, ...changes };
    await this.journals.save(this.journal);
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await fn();
      } catch (error) {
        this.logger.error('Ablauf fehlgeschlagen', error);
        this.patch({ error: this.describe(error) });
        if (this.can('FAIL')) this.go('FAIL', { error: this.describe(error) });
      }
    });
    this.queue = run;
    return run;
  }

  private describe(error: unknown): string {
    if (error instanceof FlowError) return error.message;
    if (error instanceof ApiError) return error.message;
    if (error instanceof NetworkError) return 'Server nicht erreichbar.';
    if (error instanceof HashMismatchError) return error.message;
    return 'Unerwarteter Fehler. Details stehen im Log.';
  }

  private updateHostView(): void {
    const me = this.state.me?.name ?? null;
    if (this.journal?.fencingToken != null && me !== null) {
      this.patch({
        host: {
          name: me,
          since: new Date(this.journal.startedAt).toISOString(),
          isMe: true,
        },
      });
      return;
    }
    this.patch({ host: hostView(this.world, me) });
  }

  // ================================================================ Plattform & Pfade

  private async detectPlatform(): Promise<void> {
    try {
      this.installed = await detectInstalledGames(this.fs, this.deps.run, this.deps.env);
    } catch (error) {
      this.logger.warn('Plattform-Erkennung fehlgeschlagen', error);
      this.installed = { steam: null, epic: null };
    }
    const settings = this.settings.get();
    if (settings.platform === null) {
      const suggested = suggestPlatform(this.installed);
      if (suggested !== null) await this.settings.update({ platform: suggested });
    }
    const steamRoot = this.installed.steam?.root;
    if (steamRoot !== undefined && this.deps.detectSteamCloudEnabled !== undefined) {
      try {
        this.steamCloudOn = (await this.deps.detectSteamCloudEnabled(steamRoot)) === true;
      } catch (error) {
        this.logger.warn('Steam-Cloud-Erkennung fehlgeschlagen', error);
      }
    }
  }

  private async resolveSaveDir(platform: Platform): Promise<string | null> {
    const configured = this.settings.get().saveDir;
    if (configured !== null) {
      return (await this.fs.stat(configured))?.isDirectory === true ? configured : null;
    }
    if (this.deps.env.localAppData === null) return null;
    const chosen = chooseSaveDir(await findSaveDirs(this.fs, this.deps.env.localAppData), platform);
    return chosen?.path ?? null;
  }

  private async installedBuild(platform: Platform): Promise<number | null> {
    const dir =
      platform === 'steam' ? this.installed?.steam?.gameDir : this.installed?.epic?.gameDir;
    if (dir == null) return null;
    return readInstalledBuild(this.fs, dir, platform);
  }

  // ================================================================ Verbinden & Recovery

  /** Holt me/world/crew. 'ok' | 'offline' | 'unauthorized'. */
  private async refreshServer(): Promise<'ok' | 'offline' | 'unauthorized'> {
    try {
      const me = await this.api.me();
      const world = await this.api.world();
      this.world = world;
      const crew = await this.api.crew().catch(() => null);
      this.patch({
        me: { name: me.name },
        head: world.head === null ? null : toVersionView(world.head, world.head.id),
        crew: crew === null ? this.state.crew : crew.map((c) => toCrewView(c, me.name)),
        connection: { ...this.state.connection, online: true, nextRetryInSec: null },
      });
      this.updateHostView();
      return 'ok';
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return 'unauthorized';
      if (isRetryable(error)) {
        this.patch({ connection: { online: false, latencyMs: null, nextRetryInSec: null } });
        return 'offline';
      }
      throw error;
    }
  }

  private async connect(): Promise<void> {
    if (this.state.phase !== 'verbinden') {
      if (this.can('CONNECT')) this.go('CONNECT');
      else return;
    }
    if (!this.api.hasToken()) {
      this.go('NEED_LOGIN');
      return;
    }
    const status = await this.refreshServer();
    if (status === 'unauthorized') {
      await this.tokens.clear();
      this.api.setToken(null);
      this.go('NEED_LOGIN', { error: 'Anmeldung ungültig. Bitte neu anmelden.' });
      return;
    }
    const online = status === 'ok';
    if (online) this.startPresence();

    if (this.journal !== null) {
      const recovery = recoveryFor(this.journal.phase, this.game.isRunning());
      this.logger.info(`Recovery aus Phase ${this.journal.phase}: ${recovery}`);
      if (recovery === 'DISCARD') {
        await this.clearJournal();
      } else if (recovery === 'RECOVER_FINISH' && !online) {
        await this.goJournaled('NETWORK_DOWN');
        this.scheduleRetry();
        return;
      } else {
        await this.goJournaled(recovery);
        this.updateHostView();
        if (recovery === 'RECOVER_HOSTING') {
          this.startHeartbeat();
          this.startSaveWatcher();
        } else if (recovery === 'RECOVER_FINISH') {
          await this.finish();
        } else if (recovery === 'RECOVER_RELEASE') {
          await this.release();
        } else {
          await this.cleanup();
        }
        return;
      }
    }

    if (!online) {
      this.go('CONNECTION_LOST');
      this.scheduleRetry();
      return;
    }
    this.retryAttempt = 0;
    this.go('CONNECTED', { message: this.readyMessage() });
    await this.afterReady();
  }

  private readyMessage(): string | null {
    return this.steamCloudOn ? TEXT.steamCloud : null;
  }

  private cancelRetry(): void {
    this.stopRetry?.();
    this.stopRetry = null;
    this.patch({ connection: { ...this.state.connection, nextRetryInSec: null } });
  }

  /** Neuer Versuch mit Countdown (connection.nextRetryInSec). */
  private scheduleRetry(): void {
    this.stopRetry?.();
    const backoff = this.t.retryBackoffSec;
    const seconds = backoff[Math.min(this.retryAttempt, backoff.length - 1)] ?? 30;
    this.retryAttempt++;
    let left = seconds;
    this.patch({ connection: { online: false, latencyMs: null, nextRetryInSec: left } });
    const stop = every(this.clock, 1_000, () => {
      left--;
      if (left > 0) {
        this.patch({ connection: { ...this.state.connection, nextRetryInSec: left } });
        return;
      }
      stop();
      this.stopRetry = null;
      this.patch({ connection: { ...this.state.connection, nextRetryInSec: null } });
      if (this.state.phase === 'wartet_auf_netz') {
        void this.serial(() => this.retryFinish());
      } else if (this.state.phase === 'offline') {
        void this.serial(async () => {
          this.go('CONNECT');
          await this.connect();
        });
      }
    });
    this.stopRetry = stop;
  }

  // ================================================================ Anwesenheit & Polling (Plan 6.5)

  private startPresence(): void {
    if (this.stopPresence !== null) return;
    void this.api.presence(this.game.isRunning() ? 'im_spiel' : 'launcher').catch(() => undefined);
    this.stopPresence = every(this.clock, this.t.presenceMs, () => this.presenceTick());
  }

  private async presenceTick(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.api.presence(this.game.isRunning() ? 'im_spiel' : 'launcher');
      const status = await this.refreshServer();
      if (status === 'ok' && this.state.phase === 'offline') {
        this.cancelRetry();
        void this.serial(async () => {
          if (this.state.phase !== 'offline') return;
          this.go('CONNECT');
          await this.connect();
        });
      } else if (status === 'ok' && this.state.phase === 'wartet_auf_netz') {
        this.cancelRetry();
        void this.serial(() => this.retryFinish());
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (this.can('NEED_LOGIN') && !SESSION_PHASES.has(this.state.phase)) {
          void this.serial(async () => {
            await this.tokens.clear();
            this.api.setToken(null);
            if (this.can('NEED_LOGIN'))
              this.go('NEED_LOGIN', { error: 'Anmeldung ungültig. Bitte neu anmelden.' });
          });
        }
        return;
      }
      if (!isRetryable(error)) {
        this.logger.warn('Anwesenheit fehlgeschlagen', error);
        return;
      }
      this.patch({
        connection: {
          online: false,
          latencyMs: null,
          nextRetryInSec: this.state.connection.nextRetryInSec,
        },
      });
      if (this.state.phase === 'bereit' && !this.busy) {
        void this.serial(() => {
          if (this.state.phase === 'bereit') {
            this.go('CONNECTION_LOST');
            this.scheduleRetry();
          }
          return Promise.resolve();
        });
      }
    }
  }

  // ================================================================ Nicht-Host: Quarantäne & Konfliktkopie

  /**
   * Plan 4.1 Schritt 5 + 7.4: Wer nicht hostet, hat den gemeinsamen Stand nicht im Save-Ordner.
   * Gefundene Dateien → Quarantäne. Hat einer mehr Spielzeit als der Server → erst als
   * Konfliktkopie hochladen. Läuft das Spiel gerade, wird nichts angefasst (später erneut).
   */
  private async afterReady(): Promise<void> {
    if (this.journal !== null || this.game.isRunning()) return;
    const sessionName = this.world?.sessionName ?? null;
    const platform = this.settings.get().platform;
    if (sessionName === null || platform === null) return;
    const saveDir = await this.resolveSaveDir(platform);
    if (saveDir === null) return;
    const saves = await scanSessionSaves(this.fs, saveDir, sessionName);
    if (saves.length === 0) return;

    const head = this.world?.head ?? null;
    const keep = new Set<string>();
    const newest = saves[0];
    if (newest !== undefined && head !== null && newest.header.playSeconds > head.playSeconds) {
      const sha = await sha256File(this.fs, newest.path);
      if (sha !== head.sha256) {
        try {
          const result = await this.api.upload({
            fs: this.fs,
            path: newest.path,
            sha256: sha,
            idempotencyKey: `konflikt-${sha}`,
            baseVersionId: head.id,
            leaseToken: null,
          });
          this.patch({
            message: `Lokaler Stand mit mehr Spielzeit gefunden – als Konfliktkopie ${result.version.label} hochgeladen. Im Verlauf kann die Gruppe ihn zurückholen.`,
          });
        } catch (error) {
          // Nicht hochgeladen → Datei bleibt liegen und wird beim nächsten Mal erneut versucht.
          keep.add(newest.path);
          if (error instanceof ApiError && error.status === 507)
            this.patch({ serverDiskFull: true });
          this.logger.warn('Konfliktkopie nicht hochgeladen', error);
        }
      }
    }
    const moved = await moveFilesTo(
      this.fs,
      saves.filter((s) => !keep.has(s.path)).map((s) => s.path),
      this.dirs.quarantine,
      this.clock.now(),
      'nicht-host',
    );
    if (moved.length > 0) this.logger.info(`${moved.length} Datei(en) in Quarantäne verschoben`);
  }

  // ================================================================ Spiel-Prozess

  private onGameChange(running: boolean): void {
    this.patch({ gameRunning: running });
    for (const w of this.gameWaiters.splice(0)) w(running);
    void this.api.presence(running ? 'im_spiel' : 'launcher').catch(() => undefined);
    if (running) return;
    if (this.state.phase === 'hosten') {
      void this.serial(async () => {
        if (this.state.phase !== 'hosten') return;
        await this.goJournaled('GAME_ENDED');
        await this.finish();
      });
    } else if (this.state.phase === 'mitspieler') {
      void this.serial(async () => {
        if (this.state.phase === 'mitspieler') this.go('GAME_ENDED', { message: null });
        await this.afterReady();
      });
    } else if (this.state.phase === 'bereit') {
      void this.serial(() => this.afterReady());
    }
  }

  private waitForGame(timeoutMs: number): Promise<boolean> {
    if (this.game.isRunning()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        cancel();
        resolve(v);
      };
      const waiter = (running: boolean): void => {
        if (running) finish(true);
        else this.gameWaiters.push(waiter);
      };
      this.gameWaiters.push(waiter);
      const cancel = this.clock.setTimeout(() => {
        finish(false);
      }, timeoutMs);
    });
  }

  // ================================================================ Host werden (Plan 4.2)

  private async hostFlow(platform: Platform, saveDir: string): Promise<ActionResult> {
    const startedAt = this.clock.now();
    this.journal = {
      v: 1,
      phase: 'lease_holen',
      startedAt,
      leaseId: null,
      fencingToken: null,
      baseVersionId: 0,
      sessionName: this.world?.sessionName ?? null,
      platform,
      saveDir,
      placedFile: null,
      placedSha256: null,
      lastPlaySeconds: 0,
      confirmedSha256: [],
      rejectedSha256: [],
      pendingUpload: null,
      leaseLost: false,
      notice: null,
    };
    await this.goJournaled('PLAY', { error: null, lastSaveAgeSec: null });

    // 1. Lease (atomar auf dem Server).
    let grant: LeaseGrant;
    try {
      const res = await this.api.acquireLease();
      if (res.kind === 'held') {
        await this.clearJournal();
        return await this.becomeGuest(platform, res.host, res.message);
      }
      grant = res.grant;
    } catch (error) {
      await this.clearJournal();
      if (error instanceof ApiError && error.status === 401) {
        this.go('NEED_LOGIN', { error: 'Anmeldung ungültig. Bitte neu anmelden.' });
        return { ok: false, error: 'Anmeldung ungültig.' };
      }
      if (isRetryable(error)) {
        this.go('CONNECTION_LOST', { error: TEXT.serverDown });
        this.scheduleRetry();
        return { ok: false, error: TEXT.serverDown };
      }
      throw error;
    }

    // 2. Journal: Host, Token, Basis.
    const head = grant.head;
    this.journal = {
      ...this.journal,
      leaseId: grant.leaseId,
      fencingToken: grant.fencingToken,
      baseVersionId: grant.headVersionId,
      sessionName: head?.sessionName ?? this.journal.sessionName,
      lastPlaySeconds: head?.playSeconds ?? 0,
      confirmedSha256: head === null ? [] : [head.sha256],
    };
    await this.goJournaled('LEASE_GRANTED');
    this.startHeartbeat();
    this.updateHostView();

    try {
      // 3. Download + SHA-256 + Header.
      let source: string | null = null;
      if (head !== null) {
        source = await this.downloadVersion(head);
        const header = await readSaveHeader(this.fs, source).catch(() => {
          throw new FlowError('Der Spielstand vom Server ist nicht lesbar.');
        });
        // 4. Spielversion prüfen.
        const installed = await this.installedBuild(platform);
        if (installed === null) {
          this.logger.warn('Installierte Spielversion unbekannt – Versionsprüfung übersprungen.');
        } else if (header.buildVersion > installed) {
          throw new FlowError(TEXT.tooNew);
        }
      }
      await this.goJournaled('DOWNLOADED');

      // 5. Vorhandene Dateien dieses Spielstands → Quarantäne. 6. Server-Stand ablegen.
      const sessionName = this.journal.sessionName;
      if (sessionName !== null) {
        const existing = await scanSessionSaves(this.fs, saveDir, sessionName);
        await moveFilesTo(
          this.fs,
          existing.map((s) => s.path),
          this.dirs.quarantine,
          this.clock.now(),
          'vor-host',
        );
      }
      if (source !== null && head !== null && sessionName !== null) {
        const placed = await placeSyncSave(
          this.fs,
          source,
          saveDir,
          sessionName,
          this.dirs.quarantine,
          this.clock.now(),
        );
        await this.saveJournal({ placedFile: placed, placedSha256: head.sha256 });
      }
      await this.goJournaled('PREPARED');

      // 7. Spiel über den Store-Launcher starten und auf den Prozess warten.
      if (!(await this.deps.openExternal(launchUriFor(platform, this.installed?.epic?.appName)))) {
        throw new FlowError('Satisfactory konnte nicht gestartet werden.');
      }
      const started = await this.waitForGame(this.t.gameStartTimeoutMs);
      if (!started)
        throw new FlowError('Satisfactory wurde nicht gestartet. Hostrecht wurde zurückgegeben.');
    } catch (error) {
      if (this.disposed) return { ok: false, error: 'Abgebrochen.' };
      const message = this.describe(error);
      this.logger.warn(`Host-Start abgebrochen: ${message}`, error);
      await this.goJournaled('ABORT', { error: message });
      await this.release(message);
      return { ok: false, error: message };
    }

    // 8. Hosten: Heartbeat läuft, Save-Watcher startet.
    await this.goJournaled('GAME_STARTED');
    this.startSaveWatcher();
    return { ok: true, message: 'Du hostest.' };
  }

  /** Plan 4.3: Jemand hostet schon → nur das Spiel starten, Save-Ordner bleibt unberührt. */
  private async becomeGuest(
    platform: Platform,
    host: HostInfo | null,
    serverMessage: string,
  ): Promise<ActionResult> {
    const text =
      host === null
        ? serverMessage
        : `${host.name} hostet seit ${clockTime(host.since)} – tritt über deine Freundesliste bei.`;
    const me = this.state.me?.name ?? null;
    this.go('LEASE_HELD', {
      message: text,
      host:
        host === null
          ? this.state.host
          : { name: host.name, since: host.since, isMe: host.name === me },
    });
    if (!(await this.deps.openExternal(launchUriFor(platform, this.installed?.epic?.appName)))) {
      this.go('GAME_ENDED', {
        message: null,
        error: 'Satisfactory konnte nicht gestartet werden.',
      });
      return { ok: false, error: 'Satisfactory konnte nicht gestartet werden.' };
    }
    void this.waitForGame(this.t.gameStartTimeoutMs).then((started) => {
      if (!started) {
        void this.serial(async () => {
          if (this.state.phase === 'mitspieler' && !this.game.isRunning())
            this.go('GAME_ENDED', { message: null });
          await Promise.resolve();
        });
      }
    });
    return { ok: true, message: text };
  }

  /** Download in den Cache mit Hash-Prüfung, Range-Resume und Wiederholung (Plan 8 „Download kaputt“). */
  private async downloadVersion(version: Version): Promise<string> {
    await this.fs.mkdir(this.dirs.versions);
    await this.fs.mkdir(this.dirs.downloads);
    const target = join(this.dirs.versions, `${version.id}.sav`);
    if (
      (await this.fs.stat(target)) !== null &&
      (await sha256File(this.fs, target)) === version.sha256
    ) {
      return target;
    }
    const part = join(this.dirs.downloads, `${version.id}.part`);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.t.downloadAttempts; attempt++) {
      try {
        await this.api.download({
          fs: this.fs,
          versionId: version.id,
          expectedSha256: version.sha256,
          partPath: part,
          onProgress: (received, total) => {
            const size = total ?? version.size;
            if (size > 0)
              this.patch({ progress: Math.min(100, Math.round((received / size) * 100)) });
          },
        });
        await this.fs.rename(part, target);
        return target;
      } catch (error) {
        lastError = error;
        this.logger.warn(`Download Versuch ${attempt} fehlgeschlagen`, error);
        if (!(error instanceof HashMismatchError) && !isRetryable(error)) break;
        if (attempt < this.t.downloadAttempts) await sleep(this.clock, this.t.downloadRetryMs);
      }
    }
    if (lastError instanceof HashMismatchError) {
      throw new FlowError(
        'Download beschädigt (SHA-256 stimmt nicht). Nichts wurde in den Spielstand-Ordner gelegt.',
      );
    }
    if (isRetryable(lastError))
      throw new FlowError('Download fehlgeschlagen – Server nicht erreichbar.');
    throw lastError instanceof Error ? lastError : new FlowError('Download fehlgeschlagen.');
  }

  // ================================================================ Hosten (Plan 4.4)

  private startHeartbeat(): void {
    if (this.stopHeartbeat !== null) return;
    this.stopHeartbeat = every(this.clock, this.t.heartbeatMs, () => this.heartbeatTick());
  }

  private stopHeartbeatLoop(): void {
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
  }

  private async heartbeatTick(): Promise<void> {
    const token = this.journal?.fencingToken ?? null;
    if (token === null || this.journal?.leaseLost === true) return;
    try {
      await this.api.heartbeat(token);
      if (this.state.error === TEXT.heartbeatOffline) this.patch({ error: null });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await this.saveJournal({ leaseLost: true });
        this.patch({ error: TEXT.leaseLost });
        return;
      }
      if (isRetryable(error)) {
        this.patch({
          connection: { online: false, latencyMs: null, nextRetryInSec: null },
          error: TEXT.heartbeatOffline,
        });
        return;
      }
      this.logger.warn('Heartbeat fehlgeschlagen', error);
    }
  }

  private watchRules(): {
    sessionName: string | null;
    minPlaySeconds: number;
    notBeforeMs: number;
  } {
    return {
      sessionName: this.journal?.sessionName ?? null,
      minPlaySeconds: this.journal?.lastPlaySeconds ?? 0,
      notBeforeMs: this.journal?.startedAt ?? 0,
    };
  }

  private startSaveWatcher(): void {
    if (this.journal === null || this.saveWatcher !== null) return;
    this.saveWatcher = new SaveWatcher(
      this.fs,
      this.clock,
      this.journal.saveDir,
      () => this.watchRules(),
      (save) => {
        this.enqueueUpload(save);
      },
      (save, verdict) => {
        this.logger.info(`Save ignoriert (${verdict}): ${save.name}`);
      },
      this.t.saveQuietMs,
      this.t.savePollMs,
    );
    this.saveWatcher.start();
    // Liegt noch ein unbestätigter Upload im Journal (Recovery), zuerst den abschließen.
    if (this.journal.pendingUpload !== null) this.enqueueUpload(null);
  }

  private stopSaveWatcher(): void {
    this.saveWatcher?.stop();
    this.saveWatcher = null;
    this.stopUploadRetry?.();
    this.stopUploadRetry = null;
  }

  /**
   * Upload während des Spiels. Immer erst einen offenen Upload (gleicher Idempotency-Key)
   * abschließen, dann den neuesten wartenden Save – sonst könnte ein verlorenes 201 zu einer
   * falschen Basis führen.
   */
  private enqueueUpload(save: SessionSave | null): void {
    if (save !== null) this.nextCandidate = save;
    this.uploadChain = this.uploadChain.then(async () => {
      if (this.journal === null || this.disposed || this.state.phase !== 'hosten') return;
      try {
        await this.flushPending();
        const candidate = this.nextCandidate;
        this.nextCandidate = null;
        if (candidate !== null) {
          const pending = await this.preparePending(candidate);
          if (pending !== null) await this.flushPending();
        }
      } catch (error) {
        if (error instanceof RetryLater) {
          this.scheduleUploadRetry();
          return;
        }
        this.logger.error('Upload fehlgeschlagen', error);
      }
    });
  }

  private scheduleUploadRetry(): void {
    if (this.stopUploadRetry !== null) return;
    const ms = (this.t.retryBackoffSec[1] ?? 10) * 1_000;
    const cancel = this.clock.setTimeout(() => {
      this.stopUploadRetry = null;
      this.enqueueUpload(null);
    }, ms);
    this.stopUploadRetry = cancel;
  }

  /** Schnappschuss in den Cache + Pending-Eintrag im Journal. null = schon bekannt. */
  private async preparePending(save: SessionSave): Promise<PendingUpload | null> {
    const journal = this.journal;
    if (journal === null) return null;
    await this.fs.mkdir(this.dirs.snapshots);
    const tmp = join(this.dirs.snapshots, `.${this.randomId()}.tmp`);
    await this.fs.copyFile(save.path, tmp);
    const sha = await sha256File(this.fs, tmp);
    if (journal.confirmedSha256.includes(sha) || journal.rejectedSha256.includes(sha)) {
      await this.fs.unlink(tmp);
      return null;
    }
    const snapshotPath = join(this.dirs.snapshots, `${sha}.sav`);
    await this.fs.rename(tmp, snapshotPath);
    const header = await readSaveHeader(this.fs, snapshotPath);
    const pending: PendingUpload = {
      snapshotPath,
      sourcePath: save.path,
      sha256: sha,
      playSeconds: header.playSeconds,
      idempotencyKey: this.randomId(),
      baseVersionId: journal.baseVersionId,
    };
    await this.saveJournal({ pendingUpload: pending });
    return pending;
  }

  /**
   * Schickt den offenen Upload (falls vorhanden). Wirft RetryLater bei Netz/Überlast/Platte voll;
   * der Eintrag (und Key) bleibt dann im Journal.
   */
  private async flushPending(): Promise<void> {
    const journal = this.journal;
    const pending = journal?.pendingUpload ?? null;
    if (journal === null || pending === null) return;
    let result: UploadResult | null = null;
    for (let attempt = 1; attempt <= this.t.uploadAttempts && result === null; attempt++) {
      try {
        result = await this.api.upload({
          fs: this.fs,
          path: pending.snapshotPath,
          sha256: pending.sha256,
          idempotencyKey: pending.idempotencyKey,
          baseVersionId: pending.baseVersionId,
          leaseToken: journal.fencingToken,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === 'hash_mismatch' &&
          attempt < this.t.uploadAttempts
        ) {
          continue; // Übertragung beschädigt → gleicher Key, neuer Versuch
        }
        if (error instanceof ApiError && error.status === 507) {
          this.patch({ serverDiskFull: true, error: TEXT.diskFull });
          throw new RetryLater('disk_full');
        }
        if (error instanceof ApiError && (error.status === 413 || error.status === 422)) {
          // Nicht speicherbar: nicht erneut versuchen, Datei kommt beim Aufräumen in die Quarantäne.
          await this.saveJournal({
            pendingUpload: null,
            rejectedSha256: [...journal.rejectedSha256, pending.sha256],
          });
          this.patch({ error: `Save vom Server abgelehnt: ${error.message}` });
          return;
        }
        if (isRetryable(error) || error instanceof ApiError) {
          if (error instanceof NetworkError) {
            this.patch({ connection: { online: false, latencyMs: null, nextRetryInSec: null } });
          }
          throw new RetryLater(String(error));
        }
        throw error;
      }
    }
    if (result === null) throw new RetryLater('hash_mismatch');
    await this.applyUploadResult(pending, result);
  }

  private async applyUploadResult(pending: PendingUpload, result: UploadResult): Promise<void> {
    const journal = this.journal;
    if (journal === null) return;
    if (result.version.sha256.toLowerCase() !== pending.sha256) {
      // Server bestätigt einen anderen Hash → nicht als bestätigt werten.
      throw new RetryLater('Bestätigter Hash passt nicht.');
    }
    const confirmed = [...journal.confirmedSha256, pending.sha256];
    if (result.accepted) {
      await this.saveJournal({
        pendingUpload: null,
        confirmedSha256: confirmed,
        baseVersionId: result.version.id,
        lastPlaySeconds: Math.max(journal.lastPlaySeconds, pending.playSeconds),
        sessionName: journal.sessionName ?? result.version.sessionName,
      });
      this.patch({
        serverDiskFull: false,
        head: toVersionView(result.version, result.version.id),
        error: this.state.error === TEXT.diskFull ? null : this.state.error,
      });
      this.generateMap(result.version.id, pending.snapshotPath);
    } else {
      const losesLease =
        result.conflictReason !== null && CONFLICT_REASONS_LOSING_LEASE.has(result.conflictReason);
      const notice = result.message ?? `Als Konfliktkopie ${result.version.label} gespeichert.`;
      await this.saveJournal({
        pendingUpload: null,
        confirmedSha256: confirmed,
        leaseLost: journal.leaseLost || losesLease,
        notice,
      });
      this.patch({
        serverDiskFull: false,
        error: losesLease ? `${notice} ${TEXT.leaseLost}` : notice,
      });
    }
  }

  /** Plan 6.6: Karte nach erfolgreichem Upload erzeugen und hochladen. Fehler egal. */
  private generateMap(versionId: number, snapshotPath: string): void {
    const generator = this.deps.mapGenerator;
    const cleanup = (): Promise<void> => this.fs.unlink(snapshotPath).catch(() => undefined);
    if (generator === undefined) {
      void cleanup();
      return;
    }
    void (async () => {
      try {
        const map = MapDataSchema.parse(await generator(snapshotPath));
        await this.api.putMap(versionId, map);
      } catch (error) {
        this.logger.warn('Karte nicht erzeugt/hochgeladen', error);
      } finally {
        await cleanup();
      }
    })();
  }

  // ================================================================ Beenden (Plan 4.5)

  private async retryFinish(): Promise<void> {
    if (this.state.phase !== 'wartet_auf_netz') return;
    const status = await this.refreshServer();
    if (status === 'unauthorized') {
      this.go('NEED_LOGIN', { error: 'Anmeldung ungültig. Bitte neu anmelden.' });
      return;
    }
    if (status === 'offline') {
      this.scheduleRetry();
      return;
    }
    this.startPresence();
    await this.goJournaled('RETRY');
    await this.finish();
  }

  /** Phase `beenden`: neuesten passenden Save finden, falls nötig hochladen, dann abschließen. */
  private async finish(): Promise<void> {
    this.stopSaveWatcher();
    await this.uploadChain;
    const journal = this.journal;
    if (journal === null) {
      this.go('NOTHING_TO_UPLOAD');
      await this.release();
      return;
    }

    // Neuesten Save suchen (gleiche Regeln wie der Watcher, nur ohne Ruhezeit).
    const candidates = sortNewestFirst(
      (await scanSaves(this.fs, journal.saveDir)).filter((s) =>
        journal.sessionName !== null
          ? s.header.sessionName === journal.sessionName
          : s.mtimeMs >= journal.startedAt,
      ),
    );
    const newest = candidates[0];
    if (newest !== undefined) {
      this.patch({
        lastSaveAgeSec: Math.max(0, Math.round((this.clock.now() - newest.mtimeMs) / 1000)),
      });
    }

    let needsUpload = journal.pendingUpload !== null;
    if (
      !needsUpload &&
      newest !== undefined &&
      newest.header.playSeconds >= journal.lastPlaySeconds
    ) {
      const sha = await sha256File(this.fs, newest.path);
      needsUpload = !journal.confirmedSha256.includes(sha) && !journal.rejectedSha256.includes(sha);
    }

    if (!needsUpload) {
      await this.goJournaled('NOTHING_TO_UPLOAD');
      await this.release();
      return;
    }

    await this.goJournaled('UPLOAD');
    try {
      await this.flushPending();
      if (
        newest !== undefined &&
        newest.header.playSeconds >= (this.journal?.lastPlaySeconds ?? 0)
      ) {
        const pending = await this.preparePending(newest);
        if (pending !== null) await this.flushPending();
      }
    } catch (error) {
      if (error instanceof RetryLater) {
        await this.goJournaled('NETWORK_DOWN', {
          error: this.state.serverDiskFull ? TEXT.diskFull : null,
        });
        this.scheduleRetry();
        return;
      }
      throw error;
    }
    await this.goJournaled('UPLOADED');
    await this.release();
  }

  /** Phase `lease_freigeben`: DELETE /lease. Scheitert das, läuft die Lease nach 2 min ab. */
  private async release(abortMessage?: string): Promise<void> {
    this.stopHeartbeatLoop();
    const token = this.journal?.fencingToken ?? null;
    if (token !== null && this.journal?.leaseLost !== true) {
      try {
        await this.api.releaseLease(token);
      } catch (error) {
        this.logger.warn('Lease-Freigabe fehlgeschlagen (läuft von selbst ab)', error);
      }
    }
    await this.goJournaled('RELEASED', abortMessage === undefined ? {} : { error: abortMessage });
    await this.cleanup();
  }

  /**
   * Phase `aufraeumen` (Plan 4.5 Schritt 3): Dateien des Spielstands aus dem Save-Ordner
   * verschieben – vom Server bestätigte ins Archiv (Cache), alles andere in die Quarantäne.
   */
  private async cleanup(): Promise<void> {
    this.stopSaveWatcher();
    const journal = this.journal;
    if (journal !== null) {
      const saves = (await scanSaves(this.fs, journal.saveDir)).filter((s) =>
        journal.sessionName !== null ? s.header.sessionName === journal.sessionName : false,
      );
      const toArchive: string[] = [];
      const toQuarantine: string[] = [];
      for (const save of saves) {
        const sha = await sha256File(this.fs, save.path);
        (journal.confirmedSha256.includes(sha) ? toArchive : toQuarantine).push(save.path);
      }
      const now = this.clock.now();
      await moveFilesTo(this.fs, toArchive, this.dirs.archive, now);
      await moveFilesTo(this.fs, toQuarantine, this.dirs.quarantine, now, 'unbestaetigt');
    }
    const notice = journal?.notice ?? null;
    await this.clearJournal();
    this.go('CLEANED', {
      message: notice ?? this.lastSaveNotice() ?? this.readyMessage(),
    });
    await this.refreshServer().catch(() => undefined);
    this.updateHostView();
  }

  private lastSaveNotice(): string | null {
    const age = this.state.lastSaveAgeSec;
    if (age === null) return null;
    const minutes = Math.round(age / 60);
    return minutes < 1
      ? 'Spielstand hochgeladen. Der letzte Save war gerade eben.'
      : `Spielstand hochgeladen. Der letzte Save war vor ${minutes} Min. – vor dem Beenden immer speichern.`;
  }

  private async clearJournal(): Promise<void> {
    this.journal = null;
    this.nextCandidate = null;
    await this.journals.clear();
  }

  // ================================================================ Diagnose (Tests)

  /** Kopie des Journals (nur lesen). */
  getJournal(): Journal | null {
    return this.journal === null ? null : { ...this.journal };
  }

  /** Name der Datei, die als Server-Stand abgelegt wurde (für Tests/Log). */
  placedFileName(): string | null {
    return this.journal?.placedFile == null ? null : basename(this.journal.placedFile);
  }
}
