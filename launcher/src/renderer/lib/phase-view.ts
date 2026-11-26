/**
 * Ansichtsmodell der Aktionsleiste: welcher Titel, Untertitel, Fortschritt und welche Knöpfe
 * zu welcher Phase gehören. Rein und ohne React, damit jede Phase einzeln testbar ist.
 * Texte nach docs/design/launcher-entwurf.dc.html.
 */
import type { AppState, Phase } from '../../shared/ipc';
import { formatAgoSeconds } from './format';

export type Tone = 'muted' | 'error';

export type PrimaryAction = 'play' | 'retry' | 'copySessionCode';
export type SecondaryAction = 'startGameOnly' | 'toggleHelp';

export interface PrimaryButton {
  label: string;
  /** primary = orange Hauptaktion, ghost = zurückhaltend, busy = gesperrt mit Spinner. */
  variant: 'primary' | 'ghost' | 'busy';
  action: PrimaryAction | null;
  /** Gesetzt → Knopf gesperrt, Begründung sichtbar und als title. */
  disabledReason: string | null;
}

export interface SecondaryButton {
  label: string;
  action: SecondaryAction;
  disabledReason: string | null;
}

export interface Line {
  text: string;
  tone: Tone;
}

export interface PhaseView {
  /** null → Status wird noch geladen (Skeleton). */
  title: string | null;
  sub: Line | null;
  /** 0–100 → Fortschrittsbalken; null → keiner. */
  progress: number | null;
  primary: PrimaryButton | null;
  secondary: SecondaryButton | null;
}

export interface PhaseViewOptions {
  helpOpen: boolean;
}

/** Ab diesem Alter wird „Letzter Save vor …“ beim Spielende als Warnung gezeigt. */
export const STALE_SAVE_WARN_SEC = 5 * 60;

const BUSY_PHASES: Partial<Record<Phase, { title: string; button: string; progress: boolean }>> = {
  lease_holen: { title: 'Hostrecht wird angefragt', button: 'Wird angefragt', progress: false },
  herunterladen: { title: 'Spielstand wird geladen', button: 'Wird geladen', progress: true },
  vorbereiten: { title: 'Spielstand wird vorbereitet', button: 'Wird vorbereitet', progress: true },
  spiel_starten: { title: 'Satisfactory wird gestartet', button: 'Startet', progress: false },
  beenden: { title: 'Spiel wurde beendet', button: 'Wird abgeschlossen', progress: false },
  hochladen: { title: 'Fortschritt wird gesichert', button: 'Wird hochgeladen', progress: true },
  lease_freigeben: {
    title: 'Hostrecht wird freigegeben',
    button: 'Wird freigegeben',
    progress: false,
  },
  aufraeumen: { title: 'Wird abgeschlossen', button: 'Räumt auf', progress: false },
};

const NOT_WHILE_RUNNING = 'Schließ das Spiel zuerst.';
const ALREADY_RUNNING = 'Das Spiel läuft bereits.';

function busy(label: string): PrimaryButton {
  return { label, variant: 'busy', action: null, disabledReason: null };
}

function startGameOnly(state: AppState): SecondaryButton {
  return {
    label: 'Nur Spiel starten',
    action: 'startGameOnly',
    disabledReason: state.gameRunning ? ALREADY_RUNNING : null,
  };
}

function muted(text: string | null): Line | null {
  return text === null || text === '' ? null : { text, tone: 'muted' };
}

function readyView(state: AppState): PhaseView {
  const blocked = state.gameRunning && state.host?.isMe !== true;
  const versionText =
    state.head === null
      ? 'Noch kein Spielstand auf dem Server.'
      : `Lädt Version ${state.head.label} und macht dich zum Host.`;
  return {
    title: 'Bereit zum Hosten',
    sub: blocked ? { text: NOT_WHILE_RUNNING, tone: 'muted' } : muted(versionText),
    progress: null,
    primary: {
      label: 'Spielen und hosten',
      variant: 'primary',
      action: 'play',
      disabledReason: blocked ? NOT_WHILE_RUNNING : null,
    },
    secondary: startGameOnly(state),
  };
}

function guestView(state: AppState, options: PhaseViewOptions): PhaseView {
  const hostName = state.host?.name ?? 'Jemand';
  const sub = options.helpOpen
    ? `Spiel starten, Freundesliste öffnen, bei ${hostName} auf „Beitreten“.`
    : 'Tritt über die Freundesliste bei.';
  return {
    title: `${hostName} hostet`,
    sub: muted(sub),
    progress: null,
    primary: {
      label: state.gameRunning ? 'Spiel läuft' : 'Spiel starten',
      variant: state.gameRunning ? 'ghost' : 'primary',
      action: 'play',
      disabledReason: state.gameRunning ? ALREADY_RUNNING : null,
    },
    secondary: {
      label: options.helpOpen ? 'Hilfe ausblenden' : 'Wie trete ich bei?',
      action: 'toggleHelp',
      disabledReason: null,
    },
  };
}

function hostingView(state: AppState): PhaseView {
  return {
    title: 'Spiel läuft',
    sub: muted('Autosaves werden hochgeladen. Vor dem Beenden speichern.'),
    progress: null,
    primary: state.sessionCodeAvailable
      ? {
          label: 'Session-Code kopieren',
          variant: 'ghost',
          action: 'copySessionCode',
          disabledReason: null,
        }
      : null,
    secondary: null,
  };
}

function offlineView(state: AppState): PhaseView {
  const hosting = state.host?.isMe === true;
  return {
    title: 'Server nicht erreichbar',
    sub: {
      text: hosting
        ? 'Nach 2 Minuten darf ein anderer hosten. Dein Stand bleibt als Konfliktkopie erhalten.'
        : 'Prüf deine Internetverbindung. Der Launcher versucht es weiter.',
      tone: 'error',
    },
    progress: null,
    primary: { label: 'Erneut verbinden', variant: 'ghost', action: 'retry', disabledReason: null },
    secondary: hosting ? null : startGameOnly(state),
  };
}

/** Ansicht der Aktionsleiste für einen Zustand. `state === null` → noch nichts geladen. */
export function describePhase(state: AppState | null, options: PhaseViewOptions): PhaseView {
  if (state === null || state.phase === 'verbinden') {
    return { title: null, sub: null, progress: null, primary: busy('Verbinde'), secondary: null };
  }
  const phase = state.phase;
  const busyPhase = BUSY_PHASES[phase];
  if (busyPhase !== undefined) {
    const showProgress = busyPhase.progress && state.progress !== null;
    return {
      title: busyPhase.title,
      sub: showProgress ? null : muted(state.message),
      progress: showProgress ? Math.round(state.progress ?? 0) : null,
      primary: busy(busyPhase.button),
      secondary: null,
    };
  }
  switch (phase) {
    case 'bereit':
      // Hostet schon jemand anderes, ist „bereit“ für mich die Mitspieler-Ansicht.
      if (state.host !== null && !state.host.isMe) return guestView(state, options);
      return readyView(state);
    case 'mitspieler':
      return guestView(state, options);
    case 'hosten':
      return hostingView(state);
    case 'wartet_auf_netz':
      return {
        title: 'Warte auf Verbindung',
        sub: {
          text: 'Dein Stand liegt sicher auf diesem PC und wird hochgeladen, sobald der Server erreichbar ist.',
          tone: 'muted',
        },
        progress: null,
        primary: {
          label: 'Erneut verbinden',
          variant: 'ghost',
          action: 'retry',
          disabledReason: null,
        },
        secondary: null,
      };
    case 'offline':
      return offlineView(state);
    case 'fehler':
      return {
        title: 'Vorgang abgebrochen',
        sub: { text: state.error ?? state.message ?? 'Unbekannter Fehler.', tone: 'error' },
        progress: null,
        primary: {
          label: 'Erneut versuchen',
          variant: 'ghost',
          action: 'retry',
          disabledReason: null,
        },
        secondary: startGameOnly(state),
      };
    case 'anmelden':
      return { title: 'Anmelden', sub: null, progress: null, primary: null, secondary: null };
    default:
      return { title: null, sub: null, progress: null, primary: null, secondary: null };
  }
}

/** Phasen rund ums Spielende, in denen „Letzter Save vor …“ angezeigt wird. */
const END_PHASES: ReadonlySet<Phase> = new Set([
  'beenden',
  'hochladen',
  'lease_freigeben',
  'aufraeumen',
  'wartet_auf_netz',
]);

/** Zusätzliche Hinweise unter dem Status: Speicher voll, Verbindung weg, alter Save. */
export function describeNotices(state: AppState | null): Line[] {
  if (state === null) return [];
  const notices: Line[] = [];
  const hosting = state.host?.isMe === true;

  if (state.serverDiskFull) {
    notices.push({
      text: 'Server-Speicher ist voll. Neue Stände werden gerade nicht angenommen.',
      tone: 'error',
    });
  }
  if (hosting && !state.connection.online && state.phase === 'hosten') {
    notices.push({
      text: 'Lebenszeichen kommt nicht an. Nach 2 Minuten ohne Verbindung darf ein anderer hosten.',
      tone: 'error',
    });
  }
  if (state.lastSaveAgeSec !== null) {
    const ago = formatAgoSeconds(state.lastSaveAgeSec);
    const text = `Letzter Save ${ago}${ago.endsWith('.') ? '' : '.'}`;
    if (END_PHASES.has(state.phase)) {
      const stale = state.lastSaveAgeSec >= STALE_SAVE_WARN_SEC;
      notices.push(
        stale
          ? { text: `${text} Was danach gebaut wurde, ist nicht gesichert.`, tone: 'error' }
          : { text, tone: 'muted' },
      );
    } else if (state.phase === 'hosten') {
      notices.push({ text, tone: 'muted' });
    }
  }
  if (state.error !== null && state.phase !== 'fehler') {
    notices.push({ text: state.error, tone: 'error' });
  }
  return notices;
}
