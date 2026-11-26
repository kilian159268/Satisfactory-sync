import { describe, expect, it } from 'vitest';
import {
  ActionResultSchema,
  AppStateSchema,
  IPC,
  MapDataSchema,
  RedeemInviteInputSchema,
  STATE_CHANGED_CHANNEL,
  SettingsPatchSchema,
  SettingsSchema,
  VersionIdSchema,
  VersionViewSchema,
  invokeContract,
  type AppState,
} from '../../src/shared/ipc';
import { UploadResultSchema, VersionSchema, WorldResponseSchema } from '../../src/shared/api-types';

const validState: AppState = {
  phase: 'bereit',
  progress: null,
  message: null,
  error: null,
  gameRunning: false,
  host: { name: 'Testspieler B', since: '2026-11-26T13:01:27.1234567+00:00', isMe: false },
  head: {
    id: 12,
    label: '128',
    playSeconds: 3600,
    uploadedBy: 'Testspieler B',
    uploadedAt: '2026-11-26T12:00:00Z',
    type: 'normal',
    isHead: true,
    conflictReason: null,
  },
  crew: [
    {
      name: 'Testspieler B',
      online: true,
      status: 'im_spiel',
      lastSeen: '2026-11-26T12:00:00.000Z',
      isHost: true,
      isMe: false,
    },
  ],
  connection: { online: true, latencyMs: 40, nextRetryInSec: null },
  me: { name: 'Testspieler A' },
  lastSaveAgeSec: 120,
  serverDiskFull: false,
  sessionCodeAvailable: false,
};

describe('Kanäle', () => {
  it('hat für jeden Kanal genau einen Vertrag', () => {
    expect(Object.keys(invokeContract).sort()).toEqual(Object.values(IPC).sort());
  });

  it('Kanalnamen sind eindeutig und kollidieren nicht mit dem Push-Kanal', () => {
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(STATE_CHANGED_CHANNEL);
  });

  it('Kanäle ohne Argumente lehnen zusätzliche Argumente ab', () => {
    expect(invokeContract[IPC.play].args.safeParse([]).success).toBe(true);
    expect(invokeContract[IPC.play].args.safeParse(['x']).success).toBe(false);
  });
});

describe('AppState', () => {
  it('akzeptiert einen gültigen Zustand', () => {
    expect(AppStateSchema.parse(validState)).toEqual(validState);
  });

  it('lehnt unbekannte Phase ab', () => {
    expect(AppStateSchema.safeParse({ ...validState, phase: 'leerlauf' }).success).toBe(false);
  });

  it('lehnt Fortschritt außerhalb 0–100 ab', () => {
    expect(AppStateSchema.safeParse({ ...validState, progress: 101 }).success).toBe(false);
    expect(AppStateSchema.safeParse({ ...validState, progress: -1 }).success).toBe(false);
    expect(AppStateSchema.safeParse({ ...validState, progress: 50 }).success).toBe(true);
  });

  it('lehnt fehlende Felder ab', () => {
    const { crew: _crew, ...rest } = validState;
    expect(AppStateSchema.safeParse(rest).success).toBe(false);
  });

  it('lehnt Zeitpunkte ohne ISO-Format ab', () => {
    expect(
      VersionViewSchema.safeParse({ ...validState.head, uploadedAt: '26.11.2026 12:00' }).success,
    ).toBe(false);
  });
});

describe('ActionResult', () => {
  it('akzeptiert Erfolg und Fehler', () => {
    expect(ActionResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(ActionResultSchema.safeParse({ ok: true, message: 'Fertig.' }).success).toBe(true);
    expect(ActionResultSchema.safeParse({ ok: false, error: 'Kein Netz.' }).success).toBe(true);
  });

  it('lehnt Fehler ohne Text ab', () => {
    expect(ActionResultSchema.safeParse({ ok: false }).success).toBe(false);
    expect(ActionResultSchema.safeParse({ ok: 'ja' }).success).toBe(false);
  });
});

describe('RedeemInviteInput', () => {
  const ok = { code: 'ABCD-EFGH', name: 'Testspieler A', serverUrl: 'https://sync.v3in.de' };

  it('akzeptiert gültige Eingabe und trimmt', () => {
    expect(RedeemInviteInputSchema.parse({ ...ok, name: '  Testspieler A ' }).name).toBe(
      'Testspieler A',
    );
  });

  it('lehnt leeren, zu langen oder Steuerzeichen-Namen ab', () => {
    expect(RedeemInviteInputSchema.safeParse({ ...ok, name: '   ' }).success).toBe(false);
    expect(RedeemInviteInputSchema.safeParse({ ...ok, name: 'x'.repeat(25) }).success).toBe(false);
    expect(RedeemInviteInputSchema.safeParse({ ...ok, name: 'a\u0007b' }).success).toBe(false);
  });

  it('lehnt unsichere Serveradressen ab', () => {
    for (const serverUrl of [
      'http://sync.v3in.de',
      'ftp://sync.v3in.de',
      'javascript:alert(1)',
      'https://user:pw@sync.v3in.de',
      'https://sync.v3in.de/?x=1',
      'keine-url',
    ]) {
      expect(RedeemInviteInputSchema.safeParse({ ...ok, serverUrl }).success, serverUrl).toBe(
        false,
      );
    }
  });

  it('erlaubt http nur für localhost', () => {
    expect(
      RedeemInviteInputSchema.safeParse({ ...ok, serverUrl: 'http://localhost:5080' }).success,
    ).toBe(true);
    expect(
      RedeemInviteInputSchema.safeParse({ ...ok, serverUrl: 'http://127.0.0.1:5080' }).success,
    ).toBe(true);
  });

  it('lehnt unbekannte Felder ab', () => {
    expect(RedeemInviteInputSchema.safeParse({ ...ok, admin: true }).success).toBe(false);
  });
});

describe('Settings', () => {
  const settings = {
    serverUrl: 'https://sync.v3in.de',
    platform: 'steam',
    saveDir: null,
    autostart: false,
  };

  it('akzeptiert gültige Einstellungen', () => {
    expect(SettingsSchema.safeParse(settings).success).toBe(true);
  });

  it('Patch: Teilmenge ok, unbekannte Schlüssel und falsche Typen abgelehnt', () => {
    expect(SettingsPatchSchema.safeParse({ autostart: true }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({}).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ platform: 'gog' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ autostart: 'ja' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ token: 'x' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ saveDir: '' }).success).toBe(false);
  });
});

describe('Versions-ID', () => {
  it('nur positive Ganzzahlen', () => {
    expect(VersionIdSchema.safeParse(5).success).toBe(true);
    for (const v of [0, -1, 1.5, '5', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(VersionIdSchema.safeParse(v).success, String(v)).toBe(false);
    }
  });
});

describe('MapData', () => {
  it('akzeptiert gültige Karte, lehnt NaN-Koordinaten ab', () => {
    const map = {
      version: 1,
      clusters: [{ id: 'c1', x: 1, y: 2, count: 3, topTypes: ['Konstruktor'] }],
      stations: [{ name: 'Nord', x: 0, y: 0 }],
      players: [],
      bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    };
    expect(MapDataSchema.safeParse(map).success).toBe(true);
    expect(
      MapDataSchema.safeParse({ ...map, stations: [{ name: 'Nord', x: Number.NaN, y: 0 }] })
        .success,
    ).toBe(false);
  });
});

describe('Server-API', () => {
  const version = {
    id: 12,
    number: 128,
    label: '128',
    sha256: 'a'.repeat(64),
    size: 1024,
    playSeconds: 3600,
    buildVersion: 400000,
    sessionName: 'Fabrik',
    uploadedBy: 'Testspieler B',
    uploadedAt: '2026-11-26T13:01:27.1234567+00:00',
    type: 'normal',
    baseVersionId: 11,
    conflictReason: null,
    restoredFrom: null,
    pruned: false,
    hasMap: true,
  };

  it('Version: gültig, unbekannte Felder werden entfernt', () => {
    const parsed = VersionSchema.parse({ ...version, neuesFeld: 1 });
    expect(parsed).toEqual(version);
  });

  it('UploadResult mit Konflikt', () => {
    expect(
      UploadResultSchema.safeParse({
        accepted: false,
        version: { ...version, type: 'konflikt', conflictReason: 'base_mismatch', number: null },
        conflictReason: 'base_mismatch',
        message: 'Konfliktkopie gespeichert.',
      }).success,
    ).toBe(true);
  });

  it('World ohne Head und Host', () => {
    expect(
      WorldResponseSchema.safeParse({
        sessionName: null,
        head: null,
        host: null,
        serverTime: '2026-11-26T13:01:27Z',
      }).success,
    ).toBe(true);
  });

  it('lehnt kaputten Hash ab', () => {
    expect(VersionSchema.safeParse({ ...version, sha256: 'xyz' }).success).toBe(false);
  });
});
