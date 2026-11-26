/**
 * IPC-Vertrag Renderer ↔ Main (verbindlich, siehe satisfactory-sync-spec.md).
 *
 * - Jeder invoke-Kanal hat ein Zod-Schema für die Argumente (als Tupel) und für die Antwort.
 * - Main validiert eingehende Argumente UND die Antwort des Backends; der Renderer darf vertrauen.
 * - Die TS-Typen werden aus den Schemas abgeleitet – Schema ändern, Typ folgt.
 */
import { z } from 'zod';
import { IPC, STATE_CHANGED_CHANNEL } from './channels';

export { IPC, STATE_CHANGED_CHANNEL };
export type { InvokeChannel } from './channels';

// ---------------------------------------------------------------- Bausteine

/** ISO-8601-Zeitpunkt mit `Z` oder Offset (so serialisiert .NET `DateTimeOffset`). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Versions-ID des Servers (positiv, ganzzahlig). */
export const VersionIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const PlayerNameSchema = z.string().min(1).max(64);

// ---------------------------------------------------------------- Typen des Vertrags

export const PhaseSchema = z.enum([
  'verbinden',
  'anmelden',
  'bereit',
  'lease_holen',
  'herunterladen',
  'vorbereiten',
  'spiel_starten',
  'hosten',
  'mitspieler',
  'beenden',
  'hochladen',
  'lease_freigeben',
  'aufraeumen',
  'wartet_auf_netz',
  'offline',
  'fehler',
]);
export type Phase = z.infer<typeof PhaseSchema>;
export const PHASES: readonly Phase[] = PhaseSchema.options;

export const VersionTypeSchema = z.enum(['normal', 'konflikt', 'import']);
export type VersionType = z.infer<typeof VersionTypeSchema>;

export const ConflictReasonSchema = z.enum([
  'no_lease',
  'stale_token',
  'lease_expired',
  'base_mismatch',
  'playtime_regressed',
]);
export type ConflictReason = z.infer<typeof ConflictReasonSchema>;

export const VersionViewSchema = z.object({
  id: VersionIdSchema,
  /** „128“ oder „K-3“. */
  label: z.string().min(1).max(32),
  playSeconds: z.number().int().nonnegative(),
  uploadedBy: z.string(),
  uploadedAt: IsoDateTimeSchema,
  type: VersionTypeSchema,
  isHead: z.boolean(),
  conflictReason: ConflictReasonSchema.nullable(),
});
export type VersionView = z.infer<typeof VersionViewSchema>;

export const PresenceStatusSchema = z.enum(['launcher', 'im_spiel']);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

export const CrewViewSchema = z.object({
  name: z.string(),
  online: z.boolean(),
  status: PresenceStatusSchema.nullable(),
  lastSeen: IsoDateTimeSchema.nullable(),
  isHost: z.boolean(),
  isMe: z.boolean(),
});
export type CrewView = z.infer<typeof CrewViewSchema>;

export const HostViewSchema = z.object({
  name: z.string(),
  since: IsoDateTimeSchema,
  isMe: z.boolean(),
});
export type HostView = z.infer<typeof HostViewSchema>;

export const ConnectionViewSchema = z.object({
  online: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  nextRetryInSec: z.number().int().nonnegative().nullable(),
});
export type ConnectionView = z.infer<typeof ConnectionViewSchema>;

export const AppStateSchema = z.object({
  phase: PhaseSchema,
  /** 0–100 oder null (kein messbarer Fortschritt). */
  progress: z.number().min(0).max(100).nullable(),
  /** Kurzer Statustext (deutsch) oder null. */
  message: z.string().nullable(),
  /** Fehlermeldung (deutsch) oder null. */
  error: z.string().nullable(),
  gameRunning: z.boolean(),
  host: HostViewSchema.nullable(),
  head: VersionViewSchema.nullable(),
  crew: z.array(CrewViewSchema),
  connection: ConnectionViewSchema,
  me: z.object({ name: z.string() }).nullable(),
  lastSaveAgeSec: z.number().int().nonnegative().nullable(),
  serverDiskFull: z.boolean(),
  /**
   * Erweiterung gegenüber der Spezifikation: ob `copySessionCode` gerade etwas tun kann.
   * false → der Knopf „Session-Code kopieren“ wird ausgeblendet (Plan Kapitel 10).
   */
  sessionCodeAvailable: z.boolean(),
});
export type AppState = z.infer<typeof AppStateSchema>;

export const PlatformSchema = z.enum(['steam', 'epic']);
export type Platform = z.infer<typeof PlatformSchema>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Server-Adresse: https, oder http nur für lokale Tests. Ohne Benutzerdaten, Query oder Fragment. */
export const ServerUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine(
    (value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        return false;
      }
      return url.protocol === 'https:' || LOCAL_HOSTS.has(url.hostname);
    },
    { error: 'Serveradresse muss mit https:// beginnen.' },
  );

export const SettingsSchema = z.strictObject({
  serverUrl: ServerUrlSchema,
  platform: PlatformSchema.nullable(),
  saveDir: z.string().min(1).max(1024).nullable(),
  autostart: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Teil-Update der Einstellungen; unbekannte Schlüssel werden abgelehnt. */
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const ActionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), message: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const RedeemInviteInputSchema = z.strictObject({
  code: z.string().trim().min(1).max(128),
  /** Server: 1–24 Zeichen nach Trim, keine Steuerzeichen (AuthService.MaxNameLength). */
  name: z
    .string()
    .trim()
    .min(1)
    .max(24)
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s), {
      error: 'Name darf keine Steuerzeichen enthalten.',
    }),
  serverUrl: ServerUrlSchema,
});
export type RedeemInviteInput = z.infer<typeof RedeemInviteInputSchema>;

const FiniteSchema = z.number();

/** Höhenraster: Zelle (c, r) liegt bei minX + c·cellSize, minY + r·cellSize (Meter). */
export const TERRAIN_NO_DATA = -32768;
export const TerrainSchema = z
  .object({
    minX: FiniteSchema,
    minY: FiniteSchema,
    /** Kantenlänge einer Zelle in Metern. */
    cellSize: z.number().positive().max(10_000),
    cols: z.number().int().min(1).max(512),
    rows: z.number().int().min(1).max(512),
    minZ: FiniteSchema,
    maxZ: FiniteSchema,
    /** Höhe, unter der Wasser gezeichnet wird (Meter). */
    waterZ: FiniteSchema,
    /** Int16 little-endian, zeilenweise, Meter; `TERRAIN_NO_DATA` = unbekannt. Base64. */
    heights: z.string().max(700_000),
  })
  .refine((t) => Math.floor((t.heights.length * 3) / 4) >= t.cols * t.rows * 2 - 2, {
    error: 'Höhenraster zu kurz',
  });

export const MapDataSchema = z.object({
  version: z.number().int(),
  clusters: z.array(
    z.object({
      id: z.string(),
      x: FiniteSchema,
      y: FiniteSchema,
      count: z.number().int().nonnegative(),
      topTypes: z.array(z.string()),
    }),
  ),
  stations: z.array(z.object({ name: z.string(), x: FiniteSchema, y: FiniteSchema })),
  players: z.array(z.object({ name: PlayerNameSchema, x: FiniteSchema, y: FiniteSchema })),
  bounds: z.object({
    minX: FiniteSchema,
    minY: FiniteSchema,
    maxX: FiniteSchema,
    maxY: FiniteSchema,
  }),
  /** Geschätztes Höhenrelief (Plan 6.6); fehlt bei älteren Karten. */
  terrain: TerrainSchema.optional(),
});
export type MapData = z.infer<typeof MapDataSchema>;
export type Terrain = z.infer<typeof TerrainSchema>;

// ---------------------------------------------------------------- Kanäle

const NoArgs = z.tuple([]);

/**
 * Vertrag je invoke-Kanal: `args` = Tupel der Argumente, `result` = Antwort.
 * `ipc-handlers.ts` registriert genau diese Kanäle, der Preload ruft genau diese auf.
 */
export const invokeContract = {
  [IPC.getState]: { args: NoArgs, result: AppStateSchema },
  [IPC.play]: { args: NoArgs, result: ActionResultSchema },
  [IPC.startGameOnly]: { args: NoArgs, result: ActionResultSchema },
  [IPC.retryConnection]: { args: NoArgs, result: ActionResultSchema },
  [IPC.redeemInvite]: { args: z.tuple([RedeemInviteInputSchema]), result: ActionResultSchema },
  [IPC.listVersions]: { args: NoArgs, result: z.array(VersionViewSchema) },
  [IPC.restoreVersion]: { args: z.tuple([VersionIdSchema]), result: ActionResultSchema },
  [IPC.getMap]: { args: z.tuple([VersionIdSchema]), result: MapDataSchema.nullable() },
  [IPC.getSettings]: { args: NoArgs, result: SettingsSchema },
  [IPC.updateSettings]: { args: z.tuple([SettingsPatchSchema]), result: SettingsSchema },
  [IPC.copySessionCode]: { args: NoArgs, result: ActionResultSchema },
  [IPC.windowMinimize]: { args: NoArgs, result: z.undefined() },
  [IPC.windowClose]: { args: NoArgs, result: z.undefined() },
} as const satisfies Record<(typeof IPC)[keyof typeof IPC], { args: z.ZodType; result: z.ZodType }>;

export type InvokeContract = typeof invokeContract;
export type InvokeArgs<C extends keyof InvokeContract> = z.infer<InvokeContract[C]['args']>;
export type InvokeResult<C extends keyof InvokeContract> = z.infer<InvokeContract[C]['result']>;

/** Schema für den State-Push (Main → Renderer). */
export const stateChangedSchema = AppStateSchema;

// ---------------------------------------------------------------- Renderer-API

/** Das Objekt `window.schichtwechsel`, das der Preload bereitstellt. */
export interface SchichtwechselApi {
  getState(): Promise<AppState>;
  /** Abonniert State-Änderungen; Rückgabe meldet wieder ab. */
  onState(cb: (state: AppState) => void): () => void;
  /** „Spielen und hosten“: Lease holen → laden → starten, oder als Mitspieler starten. */
  play(): Promise<ActionResult>;
  /** „Nur Spiel starten“ ohne Sync. */
  startGameOnly(): Promise<ActionResult>;
  retryConnection(): Promise<ActionResult>;
  redeemInvite(input: RedeemInviteInput): Promise<ActionResult>;
  listVersions(): Promise<VersionView[]>;
  restoreVersion(id: number): Promise<ActionResult>;
  getMap(versionId: number): Promise<MapData | null>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** Nur sinnvoll, wenn `AppState.sessionCodeAvailable`; sonst Knopf ausblenden. */
  copySessionCode(): Promise<ActionResult>;
  window: {
    minimize(): void;
    close(): void;
  };
}
