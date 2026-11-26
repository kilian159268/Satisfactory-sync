/**
 * ALLE Annahmen über Satisfactory, Steam und Epic an einer Stelle.
 *
 * Plan Kapitel 14 – auf Windows prüfen.
 *
 * Nichts davon ist bisher an einem echten Windows-PC mit installiertem Spiel geprüft. Stimmt
 * etwas nicht, wird es NUR hier geändert (und in Plan Kapitel 14 abgehakt). Jede Konstante
 * nennt, worauf die Annahme beruht.
 */

// ---------------------------------------------------------------- Start (Plan 6.2, 4.2 Schritt 7)

/** Steam-App-ID von Satisfactory. */
export const STEAM_APP_ID = '526870';

/** Start über Steam. Nie die Exe direkt starten (Steam beendet sie sonst und startet neu). */
export const STEAM_LAUNCH_URI = `steam://rungameid/${STEAM_APP_ID}`;

/**
 * Start über Epic. ANNAHME (Kapitel 14, erster Punkt): `com.epicgames.launcher://apps/<AppName>`
 * startet das Spiel ohne sichtbares Launcher-Fenster. Der AppName kommt aus dem Epic-Manifest des
 * installierten Spiels (normale Version `Crab`, Experimental hat einen eigenen Namen); ohne Manifest
 * wird `Crab` genommen.
 */
export const EPIC_DEFAULT_APP_NAME = 'Crab';
export const epicLaunchUri = (appName: string): string =>
  `com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=launch&silent=true`;
export const EPIC_LAUNCH_URI = epicLaunchUri(EPIC_DEFAULT_APP_NAME);
/** Erlaubte Zeichen eines AppName aus dem Manifest (alles andere → Standard). */
export const EPIC_APP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------- Prozess (Kapitel 14, zweiter Punkt)

/** Prozessnamen des laufenden Spiels (Groß-/Kleinschreibung egal). */
export const GAME_PROCESS_NAMES = {
  steam: 'FactoryGameSteam-Win64-Shipping.exe',
  epic: 'FactoryGameEGS-Win64-Shipping.exe',
} as const;

/** Wie oft die Prozessliste abgefragt wird (`tasklist /FO CSV /NH`). */
export const PROCESS_POLL_MS = 3_000;

/**
 * So lange muss der Prozess am Stück fehlen, bis das Spiel als beendet gilt. ANNAHME: Steam
 * startet das Spiel beim Start eventuell einmal neu; eine kurze Lücke ist kein Spielende.
 */
export const PROCESS_GONE_GRACE_MS = 10_000;

/** So lange wartet der Launcher nach dem URI-Start darauf, dass der Prozess erscheint. */
export const GAME_START_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------- Installation & Version (Plan 6.2)

/** Registry: Steam-Installationspfad (`reg query`). Erster Treffer gewinnt. */
export const STEAM_REGISTRY_KEYS: readonly { key: string; value: string }[] = [
  { key: 'HKCU\\Software\\Valve\\Steam', value: 'SteamPath' },
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', value: 'InstallPath' },
  { key: 'HKLM\\SOFTWARE\\Valve\\Steam', value: 'InstallPath' },
];

/** Steam-Bibliotheken: `<SteamRoot>\steamapps\libraryfolders.vdf`. */
export const STEAM_LIBRARY_FOLDERS_FILE = ['steamapps', 'libraryfolders.vdf'] as const;

/** Spielordner in einer Steam-Bibliothek. ANNAHME: Ordnername `Satisfactory`. */
export const STEAM_GAME_DIR = ['steamapps', 'common', 'Satisfactory'] as const;

/** Epic-Manifeste: `%PROGRAMDATA%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON). */
export const EPIC_MANIFEST_DIR = ['Epic', 'EpicGamesLauncher', 'Data', 'Manifests'] as const;

/**
 * ANNAHME: Das Epic-Manifest von Satisfactory hat einen `AppName`, der mit `Crab` beginnt
 * (z. B. `Crab`, `CrabEA`, `CrabTest`), oder den Anzeigenamen „Satisfactory“.
 */
export const EPIC_APP_NAME_PREFIX = 'Crab';
export const EPIC_DISPLAY_NAME = 'Satisfactory';

/** Ordner der Exe relativ zum Spielordner. */
export const GAME_BINARIES_DIR = ['FactoryGame', 'Binaries', 'Win64'] as const;

/**
 * ANNAHME: Neben der Exe liegt eine Unreal-`.version`-Datei (JSON) mit `Changelist`, und dieser
 * Wert entspricht der `BuildVersion` im Save-Header. Kandidaten je Plattform, erster Treffer gewinnt.
 */
export const GAME_VERSION_FILES = {
  steam: ['FactoryGameSteam-Win64-Shipping.version', 'FactoryGame-Win64-Shipping.version'],
  epic: ['FactoryGameEGS-Win64-Shipping.version', 'FactoryGame-Win64-Shipping.version'],
} as const;
/** Feld in der `.version`-Datei, das mit `BuildVersion` des Saves verglichen wird. */
export const GAME_VERSION_FIELD = 'Changelist';

// ---------------------------------------------------------------- Spielstände (Plan 6.2, 6.4)

/** `%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\<ID>\`. */
export const SAVE_GAMES_DIR = ['FactoryGame', 'Saved', 'SaveGames'] as const;

/** Steam-ID-Ordner: 17-stellige Zahl (SteamID64). */
export const STEAM_SAVE_ID = /^\d{17}$/;
/** Epic-ID-Ordner: 32 Hex-Zeichen. */
export const EPIC_SAVE_ID = /^[0-9a-f]{32}$/i;

/** Dateiendung der Spielstände. */
export const SAVE_EXTENSION = '.sav';

/**
 * Name, unter dem der Launcher den Server-Stand ablegt: `<Session>_SYNC.sav` (Plan 4.2 Schritt 6).
 * Änderungszeit = jetzt, damit er im Laden-Menü oben steht (ANNAHME: das Menü sortiert nach mtime).
 */
export function syncFileName(sessionName: string): string {
  return `${sanitizeFileStem(sessionName)}_SYNC${SAVE_EXTENSION}`;
}

/** Zeichen, die Windows in Dateinamen nicht erlaubt, werden ersetzt. */
export function sanitizeFileStem(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return cleaned === '' ? 'Spielstand' : cleaned.slice(0, 120);
}

/**
 * ANNAHME (Kapitel 14, „Blaupausen“): Blaupausen werden noch NICHT mitsynchronisiert, solange
 * nicht geprüft ist, ob sie pro Session in `SaveGames\blueprints\<Session>` liegen.
 */
export const SYNC_BLUEPRINTS = false;

// ---------------------------------------------------------------- Save-Header (Plan 6.3)

/**
 * ANNAHME (Kapitel 14, „Header-Format eines aktuellen Saves“): gleiche Reihenfolge wie der Server
 * (`server/src/SatisfactorySync.Core/Saves/SaveHeader.cs`, nach @etothepii/satisfactory-file-parser):
 * int32 HeaderVersion, int32 SaveVersion, int32 BuildVersion, [ab HeaderVersion 14: FString SaveName],
 * FString MapName, FString MapOptions, FString SessionName, int32 PlayDurationSeconds,
 * int64 SaveDateTime (Ticks). Little Endian.
 */
export const SAVE_NAME_FROM_HEADER_VERSION = 14;
export const MAX_HEADER_VERSION = 64;
export const MAX_HEADER_STRING_BYTES = 8 * 1024;
/** So viele Bytes werden höchstens vom Dateianfang gelesen. */
export const HEADER_READ_BYTES = 48 * 1024;

// ---------------------------------------------------------------- Watcher & Zeiten (Plan 4.4, 6.5)

/** Datei muss so lange unverändert sein, bevor sie gilt („Spiel ist fertig mit Schreiben“). */
export const SAVE_QUIET_MS = 5_000;
/** Abfrageintervall des Save-Watchers (Polling statt fs.watch – robuster bei Cloud-Sync). */
export const SAVE_POLL_MS = 2_000;
/** Heartbeat der Lease; Lease-Laufzeit auf dem Server 2 min. */
export const HEARTBEAT_MS = 20_000;
/** Anwesenheit jedes Launchers. */
export const PRESENCE_MS = 30_000;
/** Neuer Versuch nach Netzfehlern (Sekunden), danach bleibt der letzte Wert. */
export const RETRY_BACKOFF_SEC: readonly number[] = [5, 10, 30, 60];
