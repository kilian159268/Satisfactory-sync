/**
 * Dateien des gemeinsamen Spielstands im Save-Ordner: finden, in Quarantäne/Cache verschieben,
 * Server-Stand atomar ablegen. Hier wird NIE gelöscht – nur verschoben (Plan 2, 4.1, 4.2, 4.5).
 */
import { basename, join } from 'node:path';
import { SAVE_EXTENSION, syncFileName } from '../game-assumptions';
import { freeTarget, stampForPath } from '../files';
import type { FileSystem } from '../ports';
import { tryReadSaveHeader, type SaveHeader } from './save-header';

export interface SessionSave {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  header: SaveHeader;
}

/** Ordner des Launchers in userData. */
export class LauncherDirs {
  constructor(readonly userDataDir: string) {}
  get quarantine(): string {
    return join(this.userDataDir, 'quarantine');
  }
  get cache(): string {
    // Nicht `cache`: Unter Windows ist das derselbe Ordner wie Electrons Browser-Cache `Cache`.
    return join(this.userDataDir, 'sync-cache');
  }
  /** Verifizierte Downloads: `<versionId>.sav`. */
  get versions(): string {
    return join(this.cache, 'versions');
  }
  /** Teil-Downloads: `<versionId>.part`. */
  get downloads(): string {
    return join(this.cache, 'downloads');
  }
  /** Schnappschüsse für Uploads: `<sha256>.sav`. */
  get snapshots(): string {
    return join(this.cache, 'snapshots');
  }
  /** Bestätigte Stände nach Sessionende (Plan 4.5 Schritt 3). */
  get archive(): string {
    return join(this.cache, 'archive');
  }
}

export function isSaveFile(name: string): boolean {
  return name.toLowerCase().endsWith(SAVE_EXTENSION) && !name.startsWith('.');
}

/** Alle .sav im Ordner mit lesbarem Header (unlesbare werden übergangen, nicht angefasst). */
export async function scanSaves(fs: FileSystem, saveDir: string): Promise<SessionSave[]> {
  const out: SessionSave[] = [];
  for (const name of await fs.readdir(saveDir)) {
    if (!isSaveFile(name)) continue;
    const path = join(saveDir, name);
    const stat = await fs.stat(path);
    if (stat?.isFile !== true) continue;
    const header = await tryReadSaveHeader(fs, path);
    if (header === null) continue;
    out.push({ path, name, size: stat.size, mtimeMs: stat.mtimeMs, header });
  }
  return out;
}

/** Saves eines Sessionnamens, neueste zuerst (Spielzeit, dann Änderungszeit). */
export async function scanSessionSaves(
  fs: FileSystem,
  saveDir: string,
  sessionName: string,
): Promise<SessionSave[]> {
  return sortNewestFirst(
    (await scanSaves(fs, saveDir)).filter((s) => s.header.sessionName === sessionName),
  );
}

export function sortNewestFirst(saves: SessionSave[]): SessionSave[] {
  return [...saves].sort(
    (a, b) => b.header.playSeconds - a.header.playSeconds || b.mtimeMs - a.mtimeMs,
  );
}

/** Verschiebt Dateien in einen neuen Unterordner `<root>/<zeitstempel>[-grund]/`. Nie löschen. */
export async function moveFilesTo(
  fs: FileSystem,
  paths: readonly string[],
  root: string,
  nowMs: number,
  label?: string,
): Promise<string[]> {
  if (paths.length === 0) return [];
  const dir = join(
    root,
    label === undefined ? stampForPath(nowMs) : `${stampForPath(nowMs)}-${label}`,
  );
  await fs.mkdir(dir);
  const moved: string[] = [];
  for (const path of paths) {
    if ((await fs.stat(path)) === null) continue;
    const target = await freeTarget(fs, dir, basename(path));
    await fs.rename(path, target);
    moved.push(target);
  }
  return moved;
}

/**
 * Legt den Server-Stand atomar als `<Session>_SYNC.sav` in den Save-Ordner (Plan 4.2 Schritt 6):
 * Kopie als Temp-Datei, dann umbenennen, Änderungszeit = jetzt. Ein vorhandenes Ziel wird vorher
 * in die Quarantäne verschoben, nie überschrieben.
 */
export async function placeSyncSave(
  fs: FileSystem,
  source: string,
  saveDir: string,
  sessionName: string,
  quarantineRoot: string,
  nowMs: number,
): Promise<string> {
  await fs.mkdir(saveDir);
  const target = join(saveDir, syncFileName(sessionName));
  if ((await fs.stat(target)) !== null) {
    await moveFilesTo(fs, [target], quarantineRoot, nowMs, 'vorhanden');
  }
  const tmp = join(saveDir, `.${basename(target)}.tmp`);
  await fs.copyFile(source, tmp);
  await fs.rename(tmp, target);
  const now = new Date(nowMs);
  await fs.utimes(target, now, now);
  return target;
}
