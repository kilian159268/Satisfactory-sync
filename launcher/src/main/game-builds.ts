/**
 * Welche Save-Builds die installierte Spielversion schreibt.
 *
 * GEPRÜFT 2026-11-26 (Epic, `rel-main-1.1.0`): Die `.version`-Datei meldet Changelist 463028, die
 * Saves derselben Installation tragen BuildVersion 520140. Beide Zahlen sind also NICHT direkt
 * vergleichbar (Plan 14). Der Launcher merkt sich deshalb, welche BuildVersion die Saves haben,
 * die das Spiel mit einer bestimmten installierten Version geschrieben hat, und sperrt das Hosten
 * nur, wenn ein Server-Stand nachweislich neuer ist als alles, was diese Version je geschrieben hat.
 */
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './files';
import type { FileSystem } from './ports';

const FILE = 'game-builds.json';

export class GameBuildStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly userDataDir: string,
  ) {}

  private get path(): string {
    return join(this.userDataDir, FILE);
  }

  private async load(): Promise<Record<string, number>> {
    const raw = await readJson(this.fs, this.path);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^\d{1,12}$/.test(k) && typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
    return out;
  }

  /** Höchste Save-BuildVersion, die mit dieser installierten Version gesehen wurde; null = unbekannt. */
  async knownSaveBuild(installed: number): Promise<number | null> {
    return (await this.load())[String(installed)] ?? null;
  }

  /** Merkt sich, dass die installierte Version Saves mit `saveBuild` schreibt. */
  async record(installed: number, saveBuild: number): Promise<void> {
    const map = await this.load();
    const key = String(installed);
    if ((map[key] ?? 0) >= saveBuild) return;
    map[key] = saveBuild;
    await writeJsonAtomic(this.fs, this.path, map);
  }
}

/**
 * Darf ein Server-Stand mit `saveBuild` gehostet werden? Nur „nein“, wenn bekannt ist, welche Builds
 * die installierte Version schreibt, und der Server-Stand neuer ist.
 */
export function isTooNew(saveBuild: number, knownSaveBuild: number | null): boolean {
  return knownSaveBuild !== null && saveBuild > knownSaveBuild;
}
