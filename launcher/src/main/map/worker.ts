/**
 * Worker-Einstiegspunkt (eigener Build-Input, siehe electron.vite.config.ts → out/main/map-worker.js).
 * Liest den Spielstand, baut die Karte und schickt genau eine Nachricht zurück.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { errorText, mapDataFromSaveBytes } from './parse-save';
import type { MapWorkerInput, MapWorkerMessage } from './protocol';

// Der Parser meldet jedes unlesbare Objekt auf der Konsole; bei großen Saves wären das
// tausende Zeilen im Log des Launchers. Im Worker darum stumm schalten.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = () => undefined;
}

async function run(): Promise<MapWorkerMessage> {
  try {
    const { savePath } = workerData as MapWorkerInput;
    const bytes = await readFile(savePath);
    const data = mapDataFromSaveBytes(basename(savePath, '.sav'), bytes);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

void run().then((message) => {
  parentPort?.postMessage(message);
});
