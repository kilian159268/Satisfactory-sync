/**
 * Optionale Module anderer Bereiche (Karte: src/main/map, Cloud-Erkennung: src/main/cloud).
 * Über `import.meta.glob` eingebunden: Existiert die Datei, bündelt Vite sie als eigenen Chunk
 * (dynamischer Import); fehlt sie, ist das Ergebnis leer und der Launcher läuft ohne sie.
 * So baut der Kern auch, bevor die anderen Teile da sind.
 */
import type { MapData } from '../shared/ipc';

export type MapGenerator = (savePath: string) => Promise<MapData>;
export type SteamCloudDetector = (steamRoot: string) => Promise<boolean | null>;

interface MapModule {
  generateMapData?: MapGenerator;
}
interface CloudModule {
  detectSteamCloudEnabled?: SteamCloudDetector;
}

const mapModules = import.meta.glob<MapModule>('./map/index.ts');
const cloudModules = import.meta.glob<CloudModule>('./cloud/index.ts');

async function load<T>(modules: Record<string, () => Promise<T>>, key: string): Promise<T | null> {
  const loader = modules[key];
  if (loader === undefined) return null;
  try {
    return await loader();
  } catch (error) {
    console.warn(`[engine] Optionales Modul ${key} nicht ladbar`, error);
    return null;
  }
}

export async function loadMapGenerator(): Promise<MapGenerator | undefined> {
  const mod = await load(mapModules, './map/index.ts');
  const fn = mod?.generateMapData;
  return typeof fn === 'function' ? (savePath) => fn(savePath) : undefined;
}

export async function loadSteamCloudDetector(): Promise<SteamCloudDetector | undefined> {
  const mod = await load(cloudModules, './cloud/index.ts');
  const fn = mod?.detectSteamCloudEnabled;
  return typeof fn === 'function' ? (steamRoot) => fn(steamRoot) : undefined;
}
