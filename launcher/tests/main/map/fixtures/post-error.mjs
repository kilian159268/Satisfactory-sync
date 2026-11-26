import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ ok: false, error: 'Spielstand konnte nicht gelesen werden: kaputt' });
