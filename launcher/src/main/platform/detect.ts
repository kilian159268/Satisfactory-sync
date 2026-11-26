/**
 * Steam/Epic erkennen, Spielordner, installierte Spielversion, Save-Ordner (Plan 6.2).
 * Alle Pfade und Namen kommen aus game-assumptions.ts.
 */
import { join, normalize } from 'node:path';
import type { Platform } from '../../shared/ipc';
import {
  EPIC_APP_NAME_PATTERN,
  EPIC_APP_NAME_PREFIX,
  EPIC_CATALOG_NAMESPACE,
  EPIC_DEFAULT_APP_NAME,
  EPIC_DISPLAY_NAME,
  EPIC_MANIFEST_DIR,
  EPIC_ROOT_EXE,
  EPIC_SAVE_ID,
  EPIC_SCAN_SUBPATHS,
  GAME_BINARIES_DIRS,
  GAME_VERSION_FIELD,
  GAME_VERSION_FILES,
  SAVE_EXTENSION,
  SAVE_GAMES_DIR,
  STEAM_APP_ID,
  STEAM_GAME_DIR,
  STEAM_LIBRARY_FOLDERS_FILE,
  STEAM_REGISTRY_KEYS,
  STEAM_SAVE_ID,
} from '../game-assumptions';
import type { CommandRunner, FileSystem } from '../ports';

// ---------------------------------------------------------------- Registry

/** Wert aus der Ausgabe von `reg query <key> /v <value>` (Zeile `<value>  REG_SZ  <daten>`). */
export function parseRegQueryValue(stdout: string, valueName: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S.*?)\s{2,}(REG_\w+)\s{2,}(.*?)\s*$/.exec(line);
    if (match?.[1]?.toLowerCase() === valueName.toLowerCase() && match[3] !== undefined) {
      return match[3] === '' ? null : match[3];
    }
  }
  return null;
}

export async function findSteamRoot(run: CommandRunner): Promise<string | null> {
  for (const { key, value } of STEAM_REGISTRY_KEYS) {
    try {
      const out = await run('reg', ['query', key, '/v', value]);
      const found = parseRegQueryValue(out, value);
      // Registry liefert z. B. "c:/program files (x86)/steam"; normalize setzt die Trenner des
      // Betriebssystems (unter Windows Backslashes) und lässt die Tests unter Linux heil.
      if (found !== null) return normalize(found);
    } catch {
      // Schlüssel fehlt → nächster
    }
  }
  return null;
}

// ---------------------------------------------------------------- VDF (Steam KeyValues)

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

/** Minimaler Parser für Steams Text-KeyValues (`"key" "value"` und `"key" { … }`). */
export function parseVdf(text: string): VdfObject {
  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|([{}])|\/\/[^\n]*/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] !== undefined) tokens.push(`s:${m[1].replace(/\\(.)/g, '$1')}`);
    else if (m[2] !== undefined) tokens.push(m[2]);
  }
  let i = 0;
  const parseObject = (): VdfObject => {
    const obj: VdfObject = {};
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token === '}') return obj;
      if (!token?.startsWith('s:')) continue;
      const key = token.slice(2);
      const next = tokens[i++];
      if (next === '{') obj[key] = parseObject();
      else if (next?.startsWith('s:') === true) obj[key] = next.slice(2);
    }
    return obj;
  };
  return parseObject();
}

/** Bibliotheksordner aus libraryfolders.vdf; die mit Satisfactory zuerst. */
export function steamLibrariesFromVdf(text: string): string[] {
  const root = parseVdf(text);
  const folders = root.libraryfolders ?? root.LibraryFolders;
  if (folders === undefined || typeof folders === 'string') return [];
  const withGame: string[] = [];
  const others: string[] = [];
  for (const entry of Object.values(folders)) {
    if (typeof entry === 'string') {
      // altes Format: "1" "D:\\SteamLibrary"
      if (entry.includes(':') || entry.includes('\\')) others.push(entry);
      continue;
    }
    const path = entry.path;
    if (typeof path !== 'string') continue;
    const apps = entry.apps;
    if (typeof apps === 'object' && STEAM_APP_ID in apps) withGame.push(path);
    else others.push(path);
  }
  return [...withGame, ...others];
}

export async function findSteamGameDir(fs: FileSystem, steamRoot: string): Promise<string | null> {
  const libraries = [steamRoot];
  const vdfPath = join(steamRoot, ...STEAM_LIBRARY_FOLDERS_FILE);
  if ((await fs.stat(vdfPath)) !== null) {
    const text = new TextDecoder().decode(await fs.readFile(vdfPath));
    for (const lib of steamLibrariesFromVdf(text)) {
      if (!libraries.some((l) => l.toLowerCase() === lib.toLowerCase())) libraries.unshift(lib);
    }
  }
  for (const lib of libraries) {
    let dir = join(lib, ...STEAM_GAME_DIR);
    const manifest = join(lib, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`);
    if ((await fs.stat(manifest)) !== null) {
      const acf = parseVdf(new TextDecoder().decode(await fs.readFile(manifest)));
      const state = acf.AppState;
      if (typeof state === 'object' && typeof state.installdir === 'string') {
        dir = join(lib, 'steamapps', 'common', state.installdir);
      }
    }
    if ((await fs.stat(dir))?.isDirectory === true) return dir;
  }
  return null;
}

// ---------------------------------------------------------------- Epic

export interface EpicGame {
  gameDir: string;
  /** AppName, z. B. `CrabEA`. */
  appName: string;
  /** Aus `.egstore\*.mancpn` (für die vollständige Start-Kennung), falls vorhanden. */
  namespace?: string | undefined;
  itemId?: string | undefined;
}

const safe = (v: unknown): string | undefined =>
  typeof v === 'string' && EPIC_APP_NAME_PATTERN.test(v) ? v : undefined;

/** Liest die Epic-Kennung aus `<gameDir>/.egstore/*.mancpn`; nur für Satisfactory (Namespace `crab`). */
export async function readEpicCatalog(
  fs: FileSystem,
  gameDir: string,
): Promise<{ appName: string; namespace: string; itemId: string } | null> {
  const store = join(gameDir, '.egstore');
  for (const name of await fs.readdir(store)) {
    if (!name.toLowerCase().endsWith('.mancpn')) continue;
    try {
      const m = JSON.parse(
        new TextDecoder().decode(await fs.readFile(join(store, name))),
      ) as Record<string, unknown>;
      const appName = safe(m.AppName);
      const namespace = safe(m.CatalogNamespace);
      const itemId = safe(m.CatalogItemId);
      if (appName && namespace && itemId && namespace.toLowerCase() === EPIC_CATALOG_NAMESPACE) {
        return { appName, namespace, itemId };
      }
    } catch {
      // nächste Datei
    }
  }
  return null;
}

/** Spiele aus den klassischen Epic-Manifesten unter ProgramData. */
async function epicGamesFromManifests(fs: FileSystem, programData: string): Promise<EpicGame[]> {
  const dir = join(programData, ...EPIC_MANIFEST_DIR);
  const found: EpicGame[] = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.toLowerCase().endsWith('.item')) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(await fs.readFile(join(dir, name))));
    } catch {
      continue;
    }
    if (typeof manifest !== 'object' || manifest === null) continue;
    const m = manifest as Record<string, unknown>;
    const appName = typeof m.AppName === 'string' ? m.AppName : '';
    const display = typeof m.DisplayName === 'string' ? m.DisplayName : '';
    const location = m.InstallLocation;
    if (typeof location !== 'string') continue;
    if (
      !appName.startsWith(EPIC_APP_NAME_PREFIX) &&
      !display.trim().startsWith(EPIC_DISPLAY_NAME)
    ) {
      continue;
    }
    if ((await fs.stat(location))?.isDirectory !== true) continue;
    found.push({
      gameDir: location,
      appName: safe(appName) ?? EPIC_DEFAULT_APP_NAME,
      namespace: safe(m.CatalogNamespace),
      itemId: safe(m.CatalogItemId),
    });
  }
  return found;
}

/** Spiele in typischen Ordnern der Laufwerke (für Epic-Installationen ohne ProgramData-Manifeste). */
async function epicGamesFromFolders(
  fs: FileSystem,
  driveRoots: readonly string[],
): Promise<EpicGame[]> {
  const found: EpicGame[] = [];
  for (const root of driveRoots) {
    for (const sub of EPIC_SCAN_SUBPATHS) {
      const base = join(root, ...sub);
      for (const name of await fs.readdir(base)) {
        const gameDir = join(base, name);
        const catalog = await readEpicCatalog(fs, gameDir);
        if (catalog !== null) found.push({ gameDir, ...catalog });
      }
    }
  }
  return found;
}

/**
 * Sucht Satisfactory bei Epic: erst die Manifeste unter ProgramData, dann Spielordner auf den
 * Laufwerken (`.egstore`). Echte Epic-Installationen (mit `FactoryGameEGS.exe`) gehen vor;
 * danach die normale Version (`CrabEA`) vor anderen.
 */
export async function findEpicGame(
  fs: FileSystem,
  programData: string | null,
  driveRoots: readonly string[] = [],
): Promise<EpicGame | null> {
  const candidates = programData === null ? [] : await epicGamesFromManifests(fs, programData);
  for (const g of await epicGamesFromFolders(fs, driveRoots)) {
    if (!candidates.some((c) => c.gameDir.toLowerCase() === g.gameDir.toLowerCase()))
      candidates.push(g);
  }
  const ranked: { game: EpicGame; score: number }[] = [];
  for (const game of candidates) {
    const catalog = game.namespace === undefined ? await readEpicCatalog(fs, game.gameDir) : null;
    const full = catalog === null ? game : { ...game, ...catalog };
    const genuine = (await fs.stat(join(full.gameDir, EPIC_ROOT_EXE)))?.isFile === true;
    ranked.push({
      game: full,
      score: (genuine ? 2 : 0) + (full.appName === EPIC_DEFAULT_APP_NAME ? 1 : 0),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0]?.game ?? null;
}

/** Nur der Spielordner (für ältere Aufrufer). */
export async function findEpicGameDir(fs: FileSystem, programData: string): Promise<string | null> {
  return (await findEpicGame(fs, programData))?.gameDir ?? null;
}

// ---------------------------------------------------------------- zusammen

export interface PlatformEnv {
  /** %LOCALAPPDATA% */
  localAppData: string | null;
  /** %PROGRAMDATA% */
  programData: string | null;
  /** Vorhandene Laufwerke, z. B. `C:\`, `D:\` (für die Suche nach Epic-Spielordnern). */
  driveRoots?: readonly string[];
}

export interface InstalledGames {
  steam: { root: string; gameDir: string | null } | null;
  epic: EpicGame | null;
}

export async function detectInstalledGames(
  fs: FileSystem,
  run: CommandRunner,
  env: PlatformEnv,
): Promise<InstalledGames> {
  const result: InstalledGames = { steam: null, epic: null };
  const steamRoot = await findSteamRoot(run);
  if (steamRoot !== null) {
    result.steam = { root: steamRoot, gameDir: await findSteamGameDir(fs, steamRoot) };
  }
  result.epic = await findEpicGame(fs, env.programData, env.driveRoots ?? []);
  return result;
}

/** Plattform-Vorschlag: wo das Spiel installiert ist (Steam vor Epic, wenn beides). */
export function suggestPlatform(games: InstalledGames): Platform | null {
  if (games.steam?.gameDir != null) return 'steam';
  if (games.epic !== null) return 'epic';
  if (games.steam !== null) return 'steam';
  return null;
}

/** Installierte Spielversion (Build/Changelist) aus der `.version`-Datei neben der Exe. */
export async function readInstalledBuild(
  fs: FileSystem,
  gameDir: string,
  platform: Platform,
): Promise<number | null> {
  const paths = GAME_BINARIES_DIRS.flatMap((dir) =>
    GAME_VERSION_FILES[platform].map((file) => join(gameDir, ...dir, file)),
  );
  for (const path of paths) {
    if ((await fs.stat(path)) === null) continue;
    try {
      const json = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as unknown;
      if (typeof json === 'object' && json !== null) {
        const value = (json as Record<string, unknown>)[GAME_VERSION_FIELD];
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
      }
    } catch {
      // nächste Datei
    }
  }
  return null;
}

// ---------------------------------------------------------------- Save-Ordner

export interface SaveDirCandidate {
  id: string;
  platform: Platform;
  path: string;
  /** Jüngste Änderungszeit einer .sav darin (0 = keine). */
  newestSaveMs: number;
}

export function platformOfSaveId(id: string): Platform | null {
  if (STEAM_SAVE_ID.test(id)) return 'steam';
  if (EPIC_SAVE_ID.test(id)) return 'epic';
  return null;
}

export async function findSaveDirs(
  fs: FileSystem,
  localAppData: string,
): Promise<SaveDirCandidate[]> {
  const root = join(localAppData, ...SAVE_GAMES_DIR);
  const out: SaveDirCandidate[] = [];
  for (const id of await fs.readdir(root)) {
    const platform = platformOfSaveId(id);
    if (platform === null) continue;
    const path = join(root, id);
    if ((await fs.stat(path))?.isDirectory !== true) continue;
    let newest = 0;
    for (const name of await fs.readdir(path)) {
      if (!name.toLowerCase().endsWith(SAVE_EXTENSION)) continue;
      const s = await fs.stat(join(path, name));
      if (s?.isFile === true) newest = Math.max(newest, s.mtimeMs);
    }
    out.push({ id, platform, path, newestSaveMs: newest });
  }
  return out.sort((a, b) => b.newestSaveMs - a.newestSaveMs);
}

/**
 * Wählt den Save-Ordner zur Plattform: bei mehreren Kandidaten der mit den jüngsten Saves
 * (manuell über die Einstellung `saveDir` änderbar).
 */
export function chooseSaveDir(
  candidates: readonly SaveDirCandidate[],
  platform: Platform | null,
): SaveDirCandidate | null {
  const matching =
    platform === null ? candidates : candidates.filter((c) => c.platform === platform);
  return matching[0] ?? null;
}
