import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Einstiegspunkte sind die Standardpfade von electron-vite:
// src/main/index.ts, src/preload/index.ts, src/renderer/index.html.
const alias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rolldownOptions: {
        // Zusätzlicher Einstieg: Karten-Worker → out/main/map-worker.js (neben index.js).
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'map-worker': resolve(__dirname, 'src/main/map/worker.ts'),
        },
      },
    },
  },
  preload: {
    // Läuft in der Sandbox (CommonJS, nur `electron` verfügbar); importiert nur shared/channels.ts.
    resolve: { alias },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
  },
});
