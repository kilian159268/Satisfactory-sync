/**
 * Lokales Journal einer offenen Host-Session (Plan 4.1 Schritt 2, 4.5, 6.1). Atomar geschriebene
 * JSON-Datei in userData. Solange sie existiert (und nicht leer ist), ist die Session nicht
 * abgeschlossen – nach einem Absturz wird dort weitergemacht.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { PhaseSchema, PlatformSchema } from '../../shared/ipc';
import { readJson, writeJsonAtomic } from '../files';
import type { FileSystem } from '../ports';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const PendingUploadSchema = z.object({
  /** Schnappschuss im Launcher-Cache (wird hochgeladen, nicht die Datei im Save-Ordner). */
  snapshotPath: z.string(),
  /** Ursprüngliche Datei im Save-Ordner. */
  sourcePath: z.string(),
  sha256: Sha256,
  playSeconds: z.number().int().nonnegative(),
  /** Bleibt bei jedem Retry gleich (Plan 5.3 Schritt 4). */
  idempotencyKey: z.string().min(1).max(100),
  baseVersionId: z.number().int().nonnegative(),
});
export type PendingUpload = z.infer<typeof PendingUploadSchema>;

export const JournalSchema = z.object({
  v: z.literal(1),
  phase: PhaseSchema,
  startedAt: z.number(),
  /** null, solange die Lease noch nicht erteilt ist (Phase lease_holen). */
  leaseId: z.string().nullable(),
  fencingToken: z.number().int().nullable(),
  /** Aktuelle Basis für Compare-and-swap; 0 = es gab keinen Head. */
  baseVersionId: z.number().int().nonnegative(),
  /** Sessionname des gemeinsamen Spielstands; null, solange der Server keinen kennt. */
  sessionName: z.string().nullable(),
  platform: PlatformSchema,
  saveDir: z.string(),
  /** Datei, die der Launcher in den Save-Ordner gelegt hat (`<Session>_SYNC.sav`). */
  placedFile: z.string().nullable(),
  placedSha256: Sha256.nullable(),
  /** Spielzeit des Heads bzw. des zuletzt bestätigten Uploads (Watcher-Regel „≥ zuletzt“). */
  lastPlaySeconds: z.number().int().nonnegative(),
  /** Vom Server per Hash bestätigte Stände (auch Konfliktkopien) – nur die dürfen in den Cache. */
  confirmedSha256: z.array(Sha256),
  /** Vom Server abgelehnt und nicht gespeichert (413/422) – kommt in die Quarantäne. */
  rejectedSha256: z.array(Sha256),
  pendingUpload: PendingUploadSchema.nullable(),
  /** Lease verloren (409 lease_lost / Konfliktkopie) – Uploads werden Konfliktkopien. */
  leaseLost: z.boolean(),
  /** Hinweis für die Anzeige nach Abschluss (z. B. „als Konfliktkopie gespeichert“). */
  notice: z.string().nullable(),
});
export type Journal = z.infer<typeof JournalSchema>;

export class JournalStore {
  readonly path: string;

  constructor(
    private readonly fs: FileSystem,
    userDataDir: string,
  ) {
    this.path = join(userDataDir, 'journal.json');
  }

  /**
   * Liest das Journal. Fehlt es oder ist es leer → null. Ein kaputtes Journal (durch atomares
   * Schreiben praktisch ausgeschlossen) gilt ebenfalls als keins: Dann greift die Quarantäne beim
   * Öffnen (Plan 4.1 Schritt 5) – Dateien werden verschoben, nichts geht verloren.
   */
  async load(): Promise<Journal | null> {
    const raw = await readJson(this.fs, this.path);
    if (raw === null || typeof raw !== 'object' || Object.keys(raw).length === 0) return null;
    const parsed = JournalSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async save(journal: Journal): Promise<void> {
    await writeJsonAtomic(this.fs, this.path, JournalSchema.parse(journal));
  }

  /** Session abgeschlossen. Die Datei wird geleert (nicht gelöscht). */
  async clear(): Promise<void> {
    await writeJsonAtomic(this.fs, this.path, {});
  }
}
