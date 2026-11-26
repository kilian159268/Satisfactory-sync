/**
 * Einziger Verdrahtungspunkt der Sync-Engine (Besitz: Kern-Agent).
 * index.ts ruft nur `createBackend(context)` auf. Die echte Engine ersetzt hier die Stub.
 */
import type { BackendContext, LauncherBackend } from './backend';
import { StubBackend } from './stub-backend';

export function createBackend(_context: BackendContext): LauncherBackend {
  return new StubBackend();
}
