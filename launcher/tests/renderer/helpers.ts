import { vi, type Mock } from 'vitest';
import type {
  AppState,
  MapData,
  SchichtwechselApi,
  Settings,
  VersionView,
} from '../../src/shared/ipc';

export const ME = 'Testspieler A';
export const OTHER = 'Testspieler B';

export const HEAD: VersionView = {
  id: 200,
  label: '128',
  playSeconds: 412 * 3600 + 18 * 60,
  uploadedBy: OTHER,
  uploadedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
  type: 'normal',
  isHead: true,
  conflictReason: null,
};

export function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: 'bereit',
    progress: null,
    message: null,
    error: null,
    gameRunning: false,
    host: null,
    head: HEAD,
    crew: [
      {
        name: ME,
        online: true,
        status: 'launcher',
        lastSeen: new Date().toISOString(),
        isHost: false,
        isMe: true,
      },
      {
        name: OTHER,
        online: true,
        status: 'launcher',
        lastSeen: new Date().toISOString(),
        isHost: false,
        isMe: false,
      },
      {
        name: 'Testspieler C',
        online: false,
        status: null,
        lastSeen: new Date(Date.now() - 3 * 3600_000).toISOString(),
        isHost: false,
        isMe: false,
      },
    ],
    connection: { online: true, latencyMs: 24, nextRetryInSec: null },
    me: { name: ME },
    lastSaveAgeSec: null,
    serverDiskFull: false,
    sessionCodeAvailable: false,
    ...overrides,
  };
}

export const MAP: MapData = {
  version: 1,
  bounds: { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
  clusters: [{ id: 'c1', x: 0, y: 0, count: 312, topTypes: ['Konstruktor', 'Fertiger'] }],
  stations: [{ name: 'Nordbahnhof', x: 500, y: 200 }],
  players: [{ name: OTHER, x: -200, y: 100 }],
};

export const SETTINGS: Settings = {
  serverUrl: 'https://sync.v3in.de',
  platform: 'steam',
  saveDir: 'C:\\Spielstände',
  autostart: false,
};

type MockedApi = {
  [K in keyof Omit<SchichtwechselApi, 'window'>]: Mock<SchichtwechselApi[K]>;
} & { window: { minimize: Mock<() => void>; close: Mock<() => void> } };

export interface ApiHandle {
  api: MockedApi;
  /** Simuliert einen State-Push aus dem Main-Prozess. */
  push(state: AppState): void;
}

/** Installiert ein gemocktes `window.schichtwechsel`. */
export function installApi(state: AppState = makeState()): ApiHandle {
  const listeners = new Set<(s: AppState) => void>();
  const api: MockedApi = {
    getState: vi.fn<SchichtwechselApi['getState']>(() => Promise.resolve(state)),
    onState: vi.fn<SchichtwechselApi['onState']>((cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    play: vi.fn<SchichtwechselApi['play']>(() => Promise.resolve({ ok: true })),
    startGameOnly: vi.fn<SchichtwechselApi['startGameOnly']>(() => Promise.resolve({ ok: true })),
    retryConnection: vi.fn<SchichtwechselApi['retryConnection']>(() =>
      Promise.resolve({ ok: true }),
    ),
    redeemInvite: vi.fn<SchichtwechselApi['redeemInvite']>(() => Promise.resolve({ ok: true })),
    listVersions: vi.fn<SchichtwechselApi['listVersions']>(() => Promise.resolve([HEAD])),
    restoreVersion: vi.fn<SchichtwechselApi['restoreVersion']>(() => Promise.resolve({ ok: true })),
    getMap: vi.fn<SchichtwechselApi['getMap']>(() => Promise.resolve(MAP)),
    getSettings: vi.fn<SchichtwechselApi['getSettings']>(() => Promise.resolve(SETTINGS)),
    updateSettings: vi.fn<SchichtwechselApi['updateSettings']>((patch) =>
      Promise.resolve({ ...SETTINGS, ...patch }),
    ),
    copySessionCode: vi.fn<SchichtwechselApi['copySessionCode']>(() =>
      Promise.resolve({ ok: true }),
    ),
    window: { minimize: vi.fn(), close: vi.fn() },
  };
  Object.defineProperty(window, 'schichtwechsel', { value: api, configurable: true });
  return {
    api,
    push: (next) => {
      for (const cb of listeners) cb(next);
    },
  };
}
