import type { SchichtwechselApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Vom Preload bereitgestellt (src/preload/index.ts). */
    readonly schichtwechsel: SchichtwechselApi;
  }
}

export {};
