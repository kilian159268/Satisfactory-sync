/**
 * Server-API (Stand M1) als Zod-Schemas + TS-Typen, handgeschrieben passend zu
 * `server/src/SatisfactorySync.Api/Endpoints.cs` und `server/src/SatisfactorySync.Core/Models.cs`.
 * Sobald `contracts/openapi.yaml` existiert, wird diese Datei daraus erzeugt bzw. damit abgeglichen.
 *
 * JSON ist camelCase. Zeitpunkte sind ISO-8601 mit Offset (`DateTimeOffset`).
 * `z.object` entfernt unbekannte Felder – neue Server-Felder brechen den Launcher also nicht.
 */
import { z } from 'zod';
import { ConflictReasonSchema, IsoDateTimeSchema, VersionTypeSchema } from './ipc';

export { ConflictReasonSchema, VersionTypeSchema };
export type { ConflictReason, VersionType } from './ipc';

export const DEFAULT_SERVER_URL = 'https://sync.v3in.de';

/** Bekannte Fehlercodes (`ApiError.error`). Unbekannte Codes bleiben erlaubt. */
export const API_ERROR_CODES = [
  'unauthorized',
  'invite_invalid',
  'name_taken',
  'invalid_name',
  'lease_held',
  'lease_lost',
  'lease_active',
  'hash_mismatch',
  'too_large',
  'invalid_save',
  'wrong_session',
  'disk_full',
  'host_active',
  'version_not_found',
  'map_not_found',
  'not_uploader',
  'invalid_base_version',
  'invalid_lease_token',
  'invalid_status',
  'rate_limited',
] as const;
export type KnownApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  error: z.string(),
  /** Deutsche Meldung, direkt anzeigbar. */
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------- Modelle

export const VersionSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().nullable(),
  label: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  size: z.number().int().nonnegative(),
  playSeconds: z.number().int().nonnegative(),
  buildVersion: z.number().int(),
  sessionName: z.string(),
  uploadedBy: z.string(),
  uploadedAt: IsoDateTimeSchema,
  type: VersionTypeSchema,
  baseVersionId: z.number().int().nullable(),
  conflictReason: ConflictReasonSchema.nullable(),
  restoredFrom: z.number().int().nullable(),
  pruned: z.boolean(),
  hasMap: z.boolean(),
});
export type Version = z.infer<typeof VersionSchema>;

export const HostInfoSchema = z.object({
  name: z.string(),
  since: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  expired: z.boolean(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

export const UploadResultSchema = z.object({
  accepted: z.boolean(),
  version: VersionSchema,
  conflictReason: ConflictReasonSchema.nullable(),
  message: z.string().nullable(),
});
export type UploadResult = z.infer<typeof UploadResultSchema>;

// ---------------------------------------------------------------- Antworten je Endpunkt

/** `POST /api/auth/redeem` Body. */
export const RedeemRequestSchema = z.object({ code: z.string(), name: z.string() });
export type RedeemRequest = z.infer<typeof RedeemRequestSchema>;
/** `POST /api/auth/redeem` → 200. */
export const RedeemResponseSchema = z.object({ token: z.string().min(1), name: z.string() });
export type RedeemResponse = z.infer<typeof RedeemResponseSchema>;

/** `GET /api/me`. */
export const MeResponseSchema = z.object({ name: z.string() });
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `GET /api/world`. */
export const WorldResponseSchema = z.object({
  sessionName: z.string().nullable(),
  head: VersionSchema.nullable(),
  host: HostInfoSchema.nullable(),
  serverTime: IsoDateTimeSchema,
});
export type WorldResponse = z.infer<typeof WorldResponseSchema>;

/** `POST /api/lease` → 200. `headVersionId` 0 = kein Head. 409 `lease_held` (details = HostInfo). */
export const LeaseGrantSchema = z.object({
  leaseId: z.string(),
  fencingToken: z.number().int(),
  headVersionId: z.number().int().nonnegative(),
  expiresAt: IsoDateTimeSchema,
  head: VersionSchema.nullable(),
});
export type LeaseGrant = z.infer<typeof LeaseGrantSchema>;

/** `PUT /api/lease/heartbeat` → 200. 409 `lease_lost`. */
export const HeartbeatResponseSchema = z.object({ expiresAt: IsoDateTimeSchema });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

/** `POST /api/lease/force-release` → 200. 409 `lease_active`. */
export const ForceReleaseResponseSchema = z.object({ released: z.boolean() });
export type ForceReleaseResponse = z.infer<typeof ForceReleaseResponseSchema>;

/** `GET /api/versions` (neueste zuerst). */
export const VersionListSchema = z.array(VersionSchema);

/** `PUT /api/presence` Body. */
export const PresenceRequestSchema = z.object({ status: z.enum(['launcher', 'im_spiel']) });
export type PresenceRequest = z.infer<typeof PresenceRequestSchema>;

/** `GET /api/crew` Eintrag. */
export const CrewMemberSchema = z.object({
  name: z.string(),
  online: z.boolean(),
  status: z.enum(['launcher', 'im_spiel']).nullable(),
  lastSeen: IsoDateTimeSchema.nullable(),
  isHost: z.boolean(),
});
export type CrewMember = z.infer<typeof CrewMemberSchema>;
export const CrewListSchema = z.array(CrewMemberSchema);

/** `GET /api/audit` Eintrag. */
export const AuditEntrySchema = z.object({
  at: IsoDateTimeSchema,
  user: z.string().nullable(),
  action: z.string(),
  details: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export const AuditListSchema = z.array(AuditEntrySchema);

/** `GET /healthz` (ohne Auth). */
export const HealthResponseSchema = z.object({ status: z.literal('ok'), time: IsoDateTimeSchema });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---------------------------------------------------------------- Header

/** HTTP-Header der API (Groß-/Kleinschreibung egal). */
export const API_HEADERS = {
  authorization: 'Authorization',
  leaseToken: 'Lease-Token',
  baseVersion: 'Base-Version',
  contentSha256: 'Content-SHA256',
  idempotencyKey: 'Idempotency-Key',
} as const;
