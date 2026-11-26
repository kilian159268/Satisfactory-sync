/**
 * Stub-Backend: liefert plausible Zustände ohne Server und ohne Spiel, damit die UI sofort
 * lauffähig ist. Wird vom Kern-Agenten in create-backend.ts durch die echte Engine ersetzt.
 * Die Namen sind bewusst als Testdaten erkennbar.
 */
import { readFileSync } from 'node:fs';
import {
  MapDataSchema,
  type ActionResult,
  type AppState,
  type CrewView,
  type LinkCodeResult,
  type MapData,
  type Phase,
  type RedeemInviteInput,
  type Settings,
  type SettingsPatch,
  type VersionView,
} from '../shared/ipc';
import { DEFAULT_SERVER_URL } from '../shared/api-types';
import type { LauncherBackend, StateListener, Unsubscribe } from './backend';

const ME = 'Testspieler A';

function isoMinutesAgo(minutes: number, now: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

function makeVersions(now: number): VersionView[] {
  const versions: VersionView[] = [];
  for (let i = 0; i < 12; i++) {
    const number = 128 - i;
    versions.push({
      id: 200 - i,
      label: String(number),
      playSeconds: 412_000 - i * 3_600,
      uploadedBy: i % 3 === 0 ? ME : i % 3 === 1 ? 'Testspieler B' : 'Testspieler C',
      uploadedAt: isoMinutesAgo(45 + i * 180, now),
      type: 'normal',
      isHead: i === 0,
      conflictReason: null,
    });
  }
  versions.splice(3, 0, {
    id: 150,
    label: 'K-1',
    playSeconds: 401_000,
    uploadedBy: 'Testspieler C',
    uploadedAt: isoMinutesAgo(600, now),
    type: 'konflikt',
    isHead: false,
    conflictReason: 'stale_token',
  });
  return versions;
}

function makeCrew(now: number): CrewView[] {
  return [
    {
      name: ME,
      online: true,
      status: 'launcher',
      lastSeen: isoMinutesAgo(0, now),
      isHost: false,
      isMe: true,
    },
    {
      name: 'Testspieler B',
      online: true,
      status: 'launcher',
      lastSeen: isoMinutesAgo(1, now),
      isHost: false,
      isMe: false,
    },
    {
      name: 'Testspieler C',
      online: false,
      status: null,
      lastSeen: isoMinutesAgo(26 * 60, now),
      isHost: false,
      isMe: false,
    },
  ];
}

const STUB_MAP: MapData = {
  version: 1,
  bounds: { minX: -320_000, minY: -250_000, maxX: 425_000, maxY: 375_000 },
  clusters: [
    {
      id: 'c1',
      x: -120_000,
      y: 40_000,
      count: 312,
      topTypes: ['Konstruktor', 'Fertiger', 'Förderband'],
    },
    { id: 'c2', x: 60_000, y: -80_000, count: 128, topTypes: ['Raffinerie', 'Rohrleitung'] },
    { id: 'c3', x: 210_000, y: 150_000, count: 54, topTypes: ['Miner', 'Schmelze'] },
  ],
  stations: [
    { name: 'Nordbahnhof', x: -100_000, y: 10_000 },
    { name: 'Ölfeld', x: 70_000, y: -60_000 },
  ],
  players: [{ name: ME, x: -118_000, y: 42_000 }],
};

export interface StubBackendOptions {
  /** Verzögerung je Schritt in ms (Tests: 0). */
  stepMs?: number;
}

export class StubBackend implements LauncherBackend {
  private state: AppState;
  private settings: Settings = {
    serverUrl: DEFAULT_SERVER_URL,
    platform: 'steam',
    saveDir: null,
    autostart: false,
  };
  private readonly versions: VersionView[];
  private readonly listeners = new Set<StateListener>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly stepMs: number;
  private busy = false;

  constructor(options: StubBackendOptions = {}) {
    this.stepMs = options.stepMs ?? 900;
    const now = Date.now();
    this.versions = makeVersions(now);
    this.state = {
      phase: 'verbinden',
      progress: null,
      message: 'Verbinde mit dem Server …',
      error: null,
      gameRunning: false,
      host: null,
      head: this.versions[0] ?? null,
      crew: makeCrew(now),
      connection: { online: false, latencyMs: null, nextRetryInSec: null },
      me: { name: ME },
      lastSaveAgeSec: null,
      serverDiskFull: false,
      sessionCodeAvailable: false,
    };
  }

  start(): Promise<void> {
    this.later(() => {
      this.patch({
        phase: 'bereit',
        message: null,
        connection: { online: true, latencyMs: 38, nextRetryInSec: null },
      });
    });
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
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

  play(): Promise<ActionResult> {
    if (this.busy || this.state.gameRunning) {
      return Promise.resolve({ ok: false, error: 'Es läuft bereits ein Vorgang.' });
    }
    if (!this.state.connection.online) {
      return Promise.resolve({ ok: false, error: 'Keine Verbindung zum Server.' });
    }
    this.busy = true;
    const steps: { phase: Phase; message: string; progress?: number | null }[] = [
      { phase: 'lease_holen', message: 'Hostrecht anfragen …' },
      { phase: 'herunterladen', message: 'Spielstand herunterladen …', progress: 0 },
      { phase: 'herunterladen', message: 'Spielstand herunterladen …', progress: 45 },
      { phase: 'herunterladen', message: 'Spielstand herunterladen …', progress: 100 },
      { phase: 'vorbereiten', message: 'Spielstand vorbereiten …' },
      { phase: 'spiel_starten', message: 'Satisfactory wird gestartet …' },
    ];
    steps.forEach((step, i) => {
      this.later(() => {
        this.patch({ phase: step.phase, message: step.message, progress: step.progress ?? null });
      }, i + 1);
    });
    this.later(() => {
      this.busy = false;
      this.patch({
        phase: 'hosten',
        message: null,
        progress: null,
        gameRunning: true,
        host: { name: ME, since: new Date().toISOString(), isMe: true },
        lastSaveAgeSec: 0,
        crew: this.state.crew.map((c) => (c.isMe ? { ...c, isHost: true, status: 'im_spiel' } : c)),
      });
    }, steps.length + 1);
    return Promise.resolve({ ok: true });
  }

  startGameOnly(): Promise<ActionResult> {
    if (this.state.gameRunning) {
      return Promise.resolve({ ok: false, error: 'Das Spiel läuft bereits.' });
    }
    this.patch({ phase: 'spiel_starten', message: 'Satisfactory wird gestartet …' });
    this.later(() => {
      this.patch({ phase: 'bereit', message: null, gameRunning: true });
    });
    return Promise.resolve({ ok: true });
  }

  retryConnection(): Promise<ActionResult> {
    this.patch({ phase: 'verbinden', message: 'Verbinde mit dem Server …', error: null });
    this.later(() => {
      this.patch({
        phase: 'bereit',
        message: null,
        connection: { online: true, latencyMs: 41, nextRetryInSec: null },
      });
    });
    return Promise.resolve({ ok: true });
  }

  redeemInvite(input: RedeemInviteInput): Promise<ActionResult> {
    if (input.code.toUpperCase() === 'FALSCH') {
      return Promise.resolve({
        ok: false,
        error: 'Einladungscode ist ungültig oder schon benutzt.',
      });
    }
    this.settings = { ...this.settings, serverUrl: input.serverUrl };
    this.patch({ me: { name: input.name }, phase: 'bereit' });
    return Promise.resolve({ ok: true, message: 'Angemeldet.' });
  }

  listVersions(): Promise<VersionView[]> {
    return Promise.resolve(this.versions);
  }

  restoreVersion(id: number): Promise<ActionResult> {
    if (this.state.host !== null) {
      return Promise.resolve({ ok: false, error: 'Zurückholen geht nur, solange niemand hostet.' });
    }
    const found = this.versions.find((v) => v.id === id);
    if (!found) {
      return Promise.resolve({ ok: false, error: 'Version nicht gefunden.' });
    }
    return Promise.resolve({ ok: true, message: `Stand ${found.label} ist wieder aktuell.` });
  }

  getMap(versionId: number): Promise<MapData | null> {
    if (!this.versions.some((v) => v.id === versionId)) return Promise.resolve(null);
    // Nur für Entwicklung/Sichtprüfung: echte map.json aus einer Datei statt der Testkarte.
    const file = process.env.SCHICHTWECHSEL_STUB_MAP;
    if (file !== undefined && file !== '') {
      try {
        const parsed = MapDataSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
        if (parsed.success) return Promise.resolve(parsed.data);
      } catch {
        // Testkarte nehmen
      }
    }
    return Promise.resolve(STUB_MAP);
  }

  getSettings(): Promise<Settings> {
    return Promise.resolve(this.settings);
  }

  updateSettings(patch: SettingsPatch): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    return Promise.resolve(this.settings);
  }

  createLinkCode(): Promise<LinkCodeResult> {
    return Promise.resolve({
      ok: true,
      code: 'TEST-CODE-0001',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }

  copySessionCode(): Promise<ActionResult> {
    return Promise.resolve({ ok: false, error: 'Kein Session-Code verfügbar.' });
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  private later(fn: () => void, steps = 1): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, this.stepMs * steps);
    this.timers.add(timer);
  }
}
