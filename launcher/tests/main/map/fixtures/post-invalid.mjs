import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ ok: true, data: { version: 1, clusters: 'nein' } });
