import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({
  ok: true,
  data: {
    version: 1,
    clusters: [{ id: 'c0_0', x: 1, y: 2, count: 3, topTypes: [workerData.savePath] }],
    stations: [],
    players: [],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  },
});
