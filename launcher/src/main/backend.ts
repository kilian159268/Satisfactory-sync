/**
 * Schnittstelle zwischen IPC-Schicht und Sync-Engine. `ipc-handlers.ts` kennt nur dieses
 * Interface; die Implementierung liefert `createBackend()` (create-backend.ts).
 *
 * Regeln für Implementierungen:
 * - Alle Rückgaben müssen den Schemas aus `src/shared/ipc.ts` entsprechen (die IPC-Schicht
 *   validiert sie und wirft sonst einen Fehler an den Renderer).
 * - Erwartbare Fehler (kein Netz, Lease belegt, …) als `{ ok: false, error: '<deutscher Text>' }`
 *   zurückgeben, nicht werfen. Werfen nur bei Programmierfehlern.
 * - Argumente kommen bereits validiert an (Zod), dürfen aber inhaltlich weiter geprüft werden
 *   (z. B. ob `saveDir` existiert).
 */
import type {
  ActionResult,
  AppState,
  LinkCodeResult,
  MapData,
  RedeemInviteInput,
  Settings,
  SettingsPatch,
  VersionView,
} from '../shared/ipc';

export type StateListener = (state: AppState) => void;
export type Unsubscribe = () => void;

export interface LauncherBackend {
  /** Wird einmal nach dem Erzeugen des Fensters aufgerufen (Verbindung aufbauen, Recovery …). */
  start(): Promise<void>;
  /** Beim Beenden der App: Timer stoppen, Journal sichern. Darf nicht hängen bleiben. */
  dispose(): Promise<void>;

  /** Aktueller Zustand (Momentaufnahme). */
  getState(): Promise<AppState>;
  /** Event-Quelle: wird bei jeder Zustandsänderung mit dem vollständigen neuen Zustand aufgerufen. */
  onStateChange(listener: StateListener): Unsubscribe;

  play(): Promise<ActionResult>;
  startGameOnly(): Promise<ActionResult>;
  retryConnection(): Promise<ActionResult>;
  redeemInvite(input: RedeemInviteInput): Promise<ActionResult>;
  listVersions(): Promise<VersionView[]>;
  restoreVersion(id: number): Promise<ActionResult>;
  getMap(versionId: number): Promise<MapData | null>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  copySessionCode(): Promise<ActionResult>;
  createLinkCode(): Promise<LinkCodeResult>;
}

/**
 * Was der Main-Prozess der Engine mitgibt. Braucht die Engine mehr aus Electron, wird es hier
 * ergänzt und in index.ts befüllt (Fundament-Dateien, Änderung bitte abstimmen).
 */
export interface BackendContext {
  /** `app.getPath('userData')` – Ort für Journal, Token, Cache. */
  userDataDir: string;
  /** Version des Launchers (package.json). */
  appVersion: string;
  /** true im installierten Build, false bei `npm run dev`. */
  isPackaged: boolean;
  /**
   * Öffnet eine externe Adresse über `shell.openExternal`, aber nur, wenn sie auf der
   * Allowlist steht (security.ts). Gibt false zurück, wenn abgelehnt.
   * Zum Starten des Spiels über den Store-Launcher (steam://, com.epicgames.launcher://).
   */
  openExternal(url: string): Promise<boolean>;
  /** Text in die Zwischenablage (z. B. Session-Code). */
  writeClipboard(text: string): Promise<void>;
}
