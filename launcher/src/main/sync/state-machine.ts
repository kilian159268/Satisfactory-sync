/**
 * Zustandsmaschine der Sync-Engine (Plan 6.1) als explizite Übergangstabelle.
 * Die Engine löst nur Ereignisse aus; welche Phase daraus folgt, steht ausschließlich hier.
 * Ein Ereignis, das in der aktuellen Phase nicht vorgesehen ist, ist ein Programmierfehler.
 *
 * Plan-Namen → Phasen aus ipc.ts: Leerlauf = `bereit`, LeaseHolen = `lease_holen`,
 * Herunterladen = `herunterladen`, Vorbereiten = `vorbereiten`, SpielStarten = `spiel_starten`,
 * Hosten = `hosten`, Mitspieler = `mitspieler`, Beenden = `beenden`,
 * Abschluss-Upload = `hochladen`, LeaseFreigeben = `lease_freigeben`, Aufräumen = `aufraeumen`,
 * WartetAufNetz = `wartet_auf_netz`. Dazu: `verbinden`, `anmelden`, `offline`, `fehler`.
 */
import type { Phase } from '../../shared/ipc';

export const EVENTS = [
  /** Verbindung (neu) aufbauen, inkl. Recovery aus dem Journal. */
  'CONNECT',
  /** Kein oder ungültiges Token. */
  'NEED_LOGIN',
  /** Einladung eingelöst. */
  'LOGGED_IN',
  /** Server erreichbar, angemeldet, kein offenes Journal. */
  'CONNECTED',
  /** Server nicht erreichbar (ohne offene Session). */
  'CONNECTION_LOST',
  /** „Spielen“ gedrückt. */
  'PLAY',
  'LEASE_GRANTED',
  /** Jemand anderes hostet → Mitspieler (Plan 4.3). */
  'LEASE_HELD',
  'DOWNLOADED',
  'PREPARED',
  'GAME_STARTED',
  'GAME_ENDED',
  /** Vor dem Spielstart abgebrochen (z. B. Save von neuerer Spielversion) → Lease zurück. */
  'ABORT',
  /** Beim Beenden gibt es einen Save, der noch nicht auf dem Server ist. */
  'UPLOAD',
  'NOTHING_TO_UPLOAD',
  /** Server hat Version + Hash bestätigt (auch als Konfliktkopie). */
  'UPLOADED',
  /** Kein Netz während einer offenen Session (Journal bleibt). */
  'NETWORK_DOWN',
  /** Aus `wartet_auf_netz` erneut abschließen. */
  'RETRY',
  'RELEASED',
  'CLEANED',
  /** Recovery: Spiel läuft noch → weiter hosten. */
  'RECOVER_HOSTING',
  /** Recovery: Session abschließen (ab Plan 4.5 Schritt 2). */
  'RECOVER_FINISH',
  /** Recovery: Upload war bestätigt, Lease freigeben. */
  'RECOVER_RELEASE',
  /** Recovery: nur noch aufräumen. */
  'RECOVER_CLEANUP',
  /** Unerwarteter Fehler. */
  'FAIL',
] as const;
export type EngineEvent = (typeof EVENTS)[number];

type Table = Readonly<Record<Phase, Readonly<Partial<Record<EngineEvent, Phase>>>>>;

/** Die vollständige Übergangstabelle. `FAIL` ist zusätzlich aus jeder Phase erlaubt. */
export const TRANSITIONS: Table = {
  verbinden: {
    CONNECT: 'verbinden',
    NEED_LOGIN: 'anmelden',
    CONNECTED: 'bereit',
    CONNECTION_LOST: 'offline',
    NETWORK_DOWN: 'wartet_auf_netz',
    RECOVER_HOSTING: 'hosten',
    RECOVER_FINISH: 'beenden',
    RECOVER_RELEASE: 'lease_freigeben',
    RECOVER_CLEANUP: 'aufraeumen',
  },
  anmelden: {
    LOGGED_IN: 'verbinden',
    CONNECT: 'verbinden',
  },
  bereit: {
    CONNECT: 'verbinden',
    PLAY: 'lease_holen',
    CONNECTION_LOST: 'offline',
    NEED_LOGIN: 'anmelden',
  },
  lease_holen: {
    LEASE_GRANTED: 'herunterladen',
    LEASE_HELD: 'mitspieler',
    CONNECTION_LOST: 'offline',
    NEED_LOGIN: 'anmelden',
  },
  herunterladen: {
    DOWNLOADED: 'vorbereiten',
    ABORT: 'lease_freigeben',
  },
  vorbereiten: {
    PREPARED: 'spiel_starten',
    ABORT: 'lease_freigeben',
  },
  spiel_starten: {
    GAME_STARTED: 'hosten',
    ABORT: 'lease_freigeben',
  },
  hosten: {
    GAME_ENDED: 'beenden',
  },
  mitspieler: {
    GAME_ENDED: 'bereit',
  },
  beenden: {
    UPLOAD: 'hochladen',
    NOTHING_TO_UPLOAD: 'lease_freigeben',
    NETWORK_DOWN: 'wartet_auf_netz',
  },
  hochladen: {
    UPLOADED: 'lease_freigeben',
    NETWORK_DOWN: 'wartet_auf_netz',
  },
  lease_freigeben: {
    RELEASED: 'aufraeumen',
  },
  aufraeumen: {
    CLEANED: 'bereit',
  },
  wartet_auf_netz: {
    RETRY: 'beenden',
    NEED_LOGIN: 'anmelden',
  },
  offline: {
    CONNECT: 'verbinden',
    CONNECTED: 'bereit',
  },
  fehler: {
    CONNECT: 'verbinden',
  },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: Phase,
    readonly event: EngineEvent,
  ) {
    super(`Ungültiger Übergang: ${event} in Phase ${from}.`);
    this.name = 'InvalidTransitionError';
  }
}

/** Reducer: nächste Phase oder null, wenn das Ereignis hier nicht erlaubt ist. */
export function nextPhase(from: Phase, event: EngineEvent): Phase | null {
  if (event === 'FAIL') return 'fehler';
  return TRANSITIONS[from][event] ?? null;
}

export function transition(from: Phase, event: EngineEvent): Phase {
  const to = nextPhase(from, event);
  if (to === null) throw new InvalidTransitionError(from, event);
  return to;
}

/**
 * Phasen einer offenen Host-Session: Hier existiert ein Journal (Plan 6.1 „jeder Zustand ist im
 * Journal gespeichert“). Nach einem Absturz wird daraus weitergemacht.
 */
export const SESSION_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'lease_holen',
  'herunterladen',
  'vorbereiten',
  'spiel_starten',
  'hosten',
  'beenden',
  'hochladen',
  'lease_freigeben',
  'aufraeumen',
  'wartet_auf_netz',
]);

export type RecoveryEvent =
  | 'RECOVER_HOSTING'
  | 'RECOVER_FINISH'
  | 'RECOVER_RELEASE'
  | 'RECOVER_CLEANUP'
  /** Journal ohne Wirkung (Lease nie erhalten): verwerfen, normal weiter. */
  | 'DISCARD';

/**
 * Recovery nach Absturz (Plan 4.1 Schritt 2, 4.5): Aus der im Journal stehenden Phase und der
 * Frage, ob das Spiel gerade läuft, folgt, wo weitergemacht wird.
 */
export function recoveryFor(journalPhase: Phase, gameRunning: boolean): RecoveryEvent {
  switch (journalPhase) {
    case 'lease_holen':
      return 'DISCARD';
    case 'herunterladen':
      // Save-Ordner wurde noch nicht angefasst: Lease zurück, aufräumen.
      return 'RECOVER_RELEASE';
    case 'vorbereiten':
    case 'spiel_starten':
    case 'hosten':
    case 'beenden':
    case 'hochladen':
    case 'wartet_auf_netz':
      // Läuft das Spiel noch, wird einfach weiter gehostet (Watcher + Heartbeat);
      // sonst ab Plan 4.5 Schritt 2 abschließen.
      return gameRunning ? 'RECOVER_HOSTING' : 'RECOVER_FINISH';
    case 'lease_freigeben':
      return 'RECOVER_RELEASE';
    case 'aufraeumen':
      return 'RECOVER_CLEANUP';
    default:
      // Phasen ohne Session (bereit, offline, …) stehen nie im Journal.
      return 'DISCARD';
  }
}
