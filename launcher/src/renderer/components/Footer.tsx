import type { AppState } from '../../shared/ipc';
import { formatLatency, formatSince } from '../lib/format';
import './layout.css';

interface FooterProps {
  state: AppState | null;
  now: Date;
}

function hostLine(state: AppState | null, now: Date): { text: string; accent: boolean } {
  if (state === null || state.phase === 'verbinden') {
    return { text: 'Status wird geladen', accent: false };
  }
  if (state.host === null) return { text: 'Niemand hostet', accent: false };
  if (state.host.isMe) return { text: 'Du hostest', accent: true };
  return { text: `${state.host.name} hostet ${formatSince(state.host.since, now)}`, accent: true };
}

function connectionLine(state: AppState | null): { text: string; error: boolean } {
  if (state === null || state.phase === 'verbinden') {
    return { text: 'Verbinde mit Server …', error: false };
  }
  const { online, latencyMs, nextRetryInSec } = state.connection;
  if (online) {
    return {
      text:
        latencyMs === null
          ? 'Mit Server verbunden'
          : `Mit Server verbunden, ${formatLatency(latencyMs)}`,
      error: false,
    };
  }
  if (nextRetryInSec !== null && nextRetryInSec > 0) {
    return { text: `Keine Verbindung, neuer Versuch in ${nextRetryInSec} s`, error: true };
  }
  if (nextRetryInSec === 0) return { text: 'Keine Verbindung, neuer Versuch läuft', error: true };
  return { text: 'Keine Verbindung', error: true };
}

/** Fußzeile: wer hostet | Serververbindung. */
export function Footer({ state, now }: FooterProps) {
  const host = hostLine(state, now);
  const conn = connectionLine(state);
  return (
    <footer className="footer">
      <span className={host.accent ? 'footer__host footer__host--accent' : 'footer__host'}>
        {host.text}
      </span>
      <span className="footer__divider" aria-hidden="true" />
      <span className={conn.error ? 'footer__conn tone-error' : 'footer__conn'}>{conn.text}</span>
    </footer>
  );
}
