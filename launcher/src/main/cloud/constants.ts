/**
 * Schlüssel und Pfade für die Steam-Cloud-Erkennung (Plan 7.1). Alles hier ist aus bekannten
 * Steam-Dateien abgeleitet, aber nicht mit Satisfactory auf Windows geprüft.
 * Annahme – auf Windows prüfen (Plan Kapitel 14).
 */

/** Steam-App-ID von Satisfactory. Annahme – auf Windows prüfen (Plan Kapitel 14). */
export const SATISFACTORY_STEAM_APP_ID = '526870';

/** Ordner mit einem Unterordner je Steam-Konto (Account-ID, 32 Bit). Annahme – auf Windows prüfen (Plan Kapitel 14). */
export const USERDATA_DIR = 'userdata';

/**
 * Dateien je Konto, relativ zu `userdata/<id>/`, in Prüfreihenfolge. Der Schalter „Steam Cloud“
 * in den Spiel-Eigenschaften landet nach bisherigem Wissen in `sharedconfig.vdf` (Ordner 7/remote),
 * manche Steam-Versionen schreiben ihn auch in `localconfig.vdf`.
 * Annahme – auf Windows prüfen (Plan Kapitel 14).
 */
export const CONFIG_FILES: readonly (readonly string[])[] = [
  ['7', 'remote', 'sharedconfig.vdf'],
  ['config', 'localconfig.vdf'],
];

/** Pfad zum App-Block innerhalb des Wurzelknotens beider Dateien. Annahme – auf Windows prüfen (Plan Kapitel 14). */
export const APPS_PATH: readonly string[] = ['Software', 'Valve', 'Steam', 'apps'];

/**
 * Schlüssel des Cloud-Schalters im App-Block („0“ = aus, „1“ = an); Vergleich ohne Groß-/Kleinschreibung.
 * Fehlt der Schalter, obwohl es einen App-Block gibt, gilt die Cloud als an (Standard bei Steam).
 * Annahme – auf Windows prüfen (Plan Kapitel 14).
 */
export const APP_CLOUD_KEYS: readonly string[] = ['cloudenabled'];

/**
 * Globaler Schalter „Steam Cloud für alle Spiele“ unter Software/Valve/Steam.
 * Annahme – auf Windows prüfen (Plan Kapitel 14).
 */
export const GLOBAL_CLOUD_PATH: readonly string[] = ['Software', 'Valve', 'Steam', 'CloudEnabled'];

/** Zuletzt angemeldetes Konto: `config/loginusers.vdf`, Schlüssel `MostRecent` = „1“. Annahme – auf Windows prüfen (Plan Kapitel 14). */
export const LOGINUSERS_FILE: readonly string[] = ['config', 'loginusers.vdf'];
export const LOGINUSERS_MOST_RECENT_KEY = 'MostRecent';

/** SteamID64 − dieser Wert = Account-ID (Ordnername unter `userdata`). */
export const STEAMID64_BASE = 76561197960265728n;
