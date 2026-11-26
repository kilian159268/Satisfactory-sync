import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  defaultWorkerPath,
  generateMapData,
  runMapWorker,
  WORKER_FILE_NAME,
  type MapGenerationError,
} from '../../../src/main/map/index';

const fixture = (name: string) => resolve(__dirname, 'fixtures', name);
const dir = mkdtempSync(join(tmpdir(), 'schichtwechsel-map-'));
const savePath = join(dir, 'Test.sav');
writeFileSync(savePath, Buffer.from('kein echter Spielstand'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function rejection(p: Promise<unknown>): Promise<MapGenerationError> {
  try {
    await p;
  } catch (err) {
    return err as MapGenerationError;
  }
  throw new Error('Promise wurde nicht abgelehnt');
}

describe('generateMapData', () => {
  it('lehnt ab, wenn der Spielstand fehlt', async () => {
    const err = await rejection(generateMapData(join(dir, 'gibt-es-nicht.sav')));
    expect(err.code).toBe('nicht_gefunden');
    expect(err.message).toMatch(/Spielstand nicht gefunden/);
  });

  it('lehnt ab, wenn der Pfad ein Ordner ist', async () => {
    const err = await rejection(generateMapData(dir));
    expect(err.code).toBe('nicht_gefunden');
  });

  it('lehnt sofort ab, wenn das Signal schon abgebrochen ist', async () => {
    const err = await rejection(generateMapData(savePath, { signal: AbortSignal.abort() }));
    expect(err.code).toBe('abgebrochen');
  });
});

describe('runMapWorker (mit Ersatz-Workern)', () => {
  it('liefert das geprüfte Ergebnis und gibt den Pfad an den Worker', async () => {
    const map = await runMapWorker(fixture('post-valid.mjs'), savePath);
    expect(map.clusters[0]?.topTypes).toEqual([savePath]);
  });

  it('meldet Lesefehler des Workers klar', async () => {
    const err = await rejection(runMapWorker(fixture('post-error.mjs'), savePath));
    expect(err.code).toBe('lesefehler');
    expect(err.message).toBe('Karte: Spielstand konnte nicht gelesen werden: kaputt');
  });

  it('verwirft ein Ergebnis, das nicht dem Schema entspricht', async () => {
    const err = await rejection(runMapWorker(fixture('post-invalid.mjs'), savePath));
    expect(err.code).toBe('ungueltig');
  });

  it('bricht nach dem Timeout ab', async () => {
    const started = Date.now();
    const err = await rejection(runMapWorker(fixture('hang.mjs'), savePath, { timeoutMs: 300 }));
    expect(err.code).toBe('zeitueberschreitung');
    expect(err.message).toMatch(/Zeitüberschreitung/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('bricht über das AbortSignal ab', async () => {
    const controller = new AbortController();
    const p = runMapWorker(fixture('hang.mjs'), savePath, { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 100);
    const err = await rejection(p);
    expect(err.code).toBe('abgebrochen');
  });

  it('meldet einen Worker, der ohne Ergebnis endet', async () => {
    const err = await rejection(runMapWorker(fixture('exit.mjs'), savePath));
    expect(err.code).toBe('worker');
    expect(err.message).toMatch(/Code 3/);
  });

  it('meldet, wenn der Worker das Speicher-Limit sprengt', async () => {
    const err = await rejection(
      runMapWorker(fixture('oom.mjs'), savePath, { maxMemoryMb: 32, timeoutMs: 30_000 }),
    );
    expect(err.code).toBe('speicher');
  }, 30_000);

  it('meldet einen fehlenden Worker als Worker-Fehler', async () => {
    const err = await rejection(runMapWorker(join(dir, 'kein-worker.js'), savePath));
    expect(err.code).toBe('worker');
  });
});

describe('defaultWorkerPath', () => {
  it('sucht den Worker neben dem Bundle, sonst eine Ebene höher (Chunk)', () => {
    const outMain = join(dir, 'out', 'main');
    const chunks = join(outMain, 'chunks');
    expect(defaultWorkerPath(chunks)).toBe(join(chunks, WORKER_FILE_NAME));
    rmSync(outMain, { recursive: true, force: true });
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(outMain, WORKER_FILE_NAME), '');
    expect(defaultWorkerPath(outMain)).toBe(join(outMain, WORKER_FILE_NAME));
    expect(defaultWorkerPath(chunks)).toBe(join(outMain, WORKER_FILE_NAME));
  });
});
