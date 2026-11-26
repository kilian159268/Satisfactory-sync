/**
 * Karten-Generator (Plan 6.6): liest einen Spielstand in einem Worker-Thread ein und liefert
 * eine kleine, mit `MapDataSchema` geprüfte `MapData`.
 *
 * Fehler werden nur als abgelehnte Promise (`MapGenerationError`) gemeldet. Der Aufrufer
 * fängt sie ab; der Sync darf davon nicht abhängen.
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { MapDataSchema, type MapData } from '@shared/ipc';
import type { MapWorkerInput, MapWorkerMessage } from './protocol';

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Heap-Obergrenze des Workers. Große Saves brauchen beim Einlesen mehrere GB. */
export const DEFAULT_MAX_MEMORY_MB = 4096;
/** Dateiname des Workers im Build-Output neben `index.js` (siehe electron.vite.config.ts). */
export const WORKER_FILE_NAME = 'map-worker.js';

export type MapGenerationErrorCode =
  | 'nicht_gefunden'
  | 'lesefehler'
  | 'zeitueberschreitung'
  | 'abgebrochen'
  | 'speicher'
  | 'ungueltig'
  | 'worker';

export class MapGenerationError extends Error {
  override readonly name = 'MapGenerationError';
  constructor(
    readonly code: MapGenerationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GenerateMapOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Heap-Obergrenze des Workers in MB (Standard {@link DEFAULT_MAX_MEMORY_MB}). */
  maxMemoryMb?: number;
}

export function generateMapData(savePath: string, opts: GenerateMapOptions = {}): Promise<MapData> {
  return runMapWorker(defaultWorkerPath(), savePath, opts);
}

/**
 * Pfad des gebauten Workers. `__dirname` ist im gebündelten Main `out/main` (bzw.
 * `app.asar/out/main`), dort liegt auch `map-worker.js`. Landet dieser Code in einem
 * Chunk (`out/main/chunks/`), liegt der Worker eine Ebene höher.
 */
export function defaultWorkerPath(baseDir: string = __dirname): string {
  const candidates = [join(baseDir, WORKER_FILE_NAME), join(baseDir, '..', WORKER_FILE_NAME)];
  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? WORKER_FILE_NAME;
}

/** Startet `workerFile` für `savePath`. Eigene Funktion, damit Tests einen Ersatz-Worker nutzen. */
export async function runMapWorker(
  workerFile: string,
  savePath: string,
  opts: GenerateMapOptions = {},
): Promise<MapData> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxMemoryMb = opts.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
  const { signal } = opts;

  if (signal?.aborted) throw aborted();
  await ensureFile(savePath);
  if (signal?.aborted) throw aborted();

  return new Promise<MapData>((resolve, reject) => {
    const input: MapWorkerInput = { savePath };
    const worker = new Worker(workerFile, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb },
      stdout: false,
      stderr: false,
    });
    let settled = false;

    const finish = (result: { data: MapData } | { error: MapGenerationError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      if ('data' in result) resolve(result.data);
      else reject(result.error);
    };

    const onAbort = (): void => {
      finish({ error: aborted() });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Wird nur asynchron (nach dieser Zeile) über `finish` gelesen.
    const timer = setTimeout(() => {
      finish({
        error: new MapGenerationError(
          'zeitueberschreitung',
          `Karte: Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s.`,
        ),
      });
    }, timeoutMs);

    worker.on('message', (message: MapWorkerMessage) => {
      if (!message.ok) {
        finish({ error: new MapGenerationError('lesefehler', `Karte: ${message.error}`) });
        return;
      }
      const parsed = MapDataSchema.safeParse(message.data);
      if (parsed.success) finish({ data: parsed.data });
      else
        finish({
          error: new MapGenerationError('ungueltig', 'Karte: Ergebnis des Workers ist ungültig.', {
            cause: parsed.error,
          }),
        });
    });

    worker.on('error', (err: Error & { code?: string }) => {
      const memory = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish({
        error: new MapGenerationError(
          memory ? 'speicher' : 'worker',
          memory
            ? 'Karte: Zu wenig Arbeitsspeicher zum Einlesen des Spielstands.'
            : `Karte: Worker-Fehler: ${err.message}`,
          { cause: err },
        ),
      });
    });

    worker.on('exit', (code) => {
      finish({
        error: new MapGenerationError(
          'worker',
          `Karte: Worker ohne Ergebnis beendet (Code ${code}).`,
        ),
      });
    });
  });
}

async function ensureFile(savePath: string): Promise<void> {
  try {
    const info = await stat(savePath);
    if (info.isFile()) return;
  } catch {
    // unten gemeinsam gemeldet
  }
  throw new MapGenerationError('nicht_gefunden', `Karte: Spielstand nicht gefunden: ${savePath}`);
}

function aborted(): MapGenerationError {
  return new MapGenerationError('abgebrochen', 'Karte: Einlesen abgebrochen.');
}
