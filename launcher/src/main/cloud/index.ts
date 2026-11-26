/**
 * Steam-Cloud-Erkennung (Plan 7.1): Ist Steam Cloud für Satisfactory noch eingeschaltet?
 * Liest nur Dateien, schreibt nie etwas. Alle Schlüssel/Pfade stehen in `./constants.ts`
 * (Annahmen – auf Windows prüfen, Plan Kapitel 14).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APP_CLOUD_KEYS,
  APPS_PATH,
  CONFIG_FILES,
  GLOBAL_CLOUD_PATH,
  LOGINUSERS_FILE,
  LOGINUSERS_MOST_RECENT_KEY,
  SATISFACTORY_STEAM_APP_ID,
  STEAMID64_BASE,
  USERDATA_DIR,
} from './constants';
import { getChild, getPath, parseVdf, type VdfObject, type VdfValue } from './vdf';

export { parseVdf, VdfParseError, type VdfObject, type VdfValue } from './vdf';

/** Schmale Dateisystem-Schnittstelle, damit Tests ohne echte Steam-Installation laufen. */
export interface CloudFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const nodeFs: CloudFs = {
  readFile: (path, encoding) => readFile(path, encoding),
  readdir: (path) => readdir(path),
};

/** Größere Dateien werden nicht geparst (localconfig.vdf ist üblicherweise < 5 MB). */
const MAX_FILE_CHARS = 32 * 1024 * 1024;

/** Liest und parst eine VDF-Datei; `undefined`, wenn sie fehlt, zu groß oder kaputt ist. */
async function readVdf(fs: CloudFs, path: string): Promise<VdfObject | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  if (text.length > MAX_FILE_CHARS) return undefined;
  try {
    return parseVdf(text);
  } catch {
    return undefined;
  }
}

/** Der einzige Wurzelblock („UserLocalConfigStore“, „UserRoamingConfigStore“, „users“ …). */
function rootBlock(doc: VdfObject): VdfValue | undefined {
  const values = Object.values(doc);
  return values.length === 1 ? values[0] : undefined;
}

function parseSwitch(value: VdfValue | undefined): boolean | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return null;
}

/** Account-ID des zuletzt angemeldeten Kontos aus `config/loginusers.vdf`, sonst null. */
export async function mostRecentAccountId(
  steamRoot: string,
  fs: CloudFs = nodeFs,
): Promise<string | null> {
  const doc = await readVdf(fs, join(steamRoot, ...LOGINUSERS_FILE));
  if (doc === undefined) return null;
  const users = rootBlock(doc);
  if (users === undefined || typeof users === 'string') return null;
  for (const [steamId64, entry] of Object.entries(users)) {
    if (parseSwitch(getChild(entry, LOGINUSERS_MOST_RECENT_KEY)) !== true) continue;
    if (!/^\d{17}$/.test(steamId64)) return null;
    const accountId = BigInt(steamId64) - STEAMID64_BASE;
    return accountId > 0n ? accountId.toString() : null;
  }
  return null;
}

/**
 * Cloud-Status für ein Konto (`userdata/<accountId>`): false = aus (global oder für die App),
 * true = an (Schalter an oder App bekannt ohne Schalter → Steam-Standard), null = unbekannt.
 */
export async function detectForAccount(
  steamRoot: string,
  accountId: string,
  fs: CloudFs = nodeFs,
): Promise<boolean | null> {
  const roots: VdfValue[] = [];
  for (const parts of CONFIG_FILES) {
    const doc = await readVdf(fs, join(steamRoot, USERDATA_DIR, accountId, ...parts));
    const root = doc === undefined ? undefined : rootBlock(doc);
    if (root !== undefined) roots.push(root);
  }

  // Global ausgeschaltet schlägt alles.
  if (roots.some((root) => parseSwitch(getPath(root, GLOBAL_CLOUD_PATH)) === false)) return false;

  let appKnown = false;
  for (const root of roots) {
    const app = getPath(root, [...APPS_PATH, SATISFACTORY_STEAM_APP_ID]);
    if (app === undefined || typeof app === 'string') continue;
    appKnown = true;
    for (const key of APP_CLOUD_KEYS) {
      const value = parseSwitch(getChild(app, key));
      if (value !== null) return value;
    }
  }
  return appKnown ? true : null;
}

/**
 * Ist Steam Cloud für Satisfactory eingeschaltet?
 * Geprüft wird das zuletzt angemeldete Konto; ist das nicht bestimmbar, alle Konten unter
 * `userdata` (eines an → true, sonst eines aus → false). `null` = unbekannt (kein Steam,
 * kein Konto, Spiel nie gestartet oder Dateien unlesbar).
 */
export async function detectSteamCloudEnabled(
  steamRoot: string,
  fs: CloudFs = nodeFs,
): Promise<boolean | null> {
  let accounts: string[];
  try {
    accounts = (await fs.readdir(join(steamRoot, USERDATA_DIR))).filter((name) =>
      /^\d+$/.test(name),
    );
  } catch {
    return null;
  }
  if (accounts.length === 0) return null;

  const recent = await mostRecentAccountId(steamRoot, fs);
  if (recent !== null && accounts.includes(recent)) {
    const result = await detectForAccount(steamRoot, recent, fs);
    if (result !== null) return result;
  }

  let anyOff = false;
  for (const account of accounts) {
    const result = await detectForAccount(steamRoot, account, fs);
    if (result === true) return true;
    if (result === false) anyOff = true;
  }
  return anyOff ? false : null;
}
