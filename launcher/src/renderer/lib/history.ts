/** Texte und Regeln für den Verlauf. */
import type { AppState, ConflictReason, VersionView } from '../../shared/ipc';

export const CONFLICT_REASONS: Record<ConflictReason, string> = {
  no_lease: 'Ohne Hostrecht hochgeladen.',
  stale_token: 'Hostrecht war schon weitergegeben.',
  lease_expired: 'Hostrecht war abgelaufen.',
  base_mismatch: 'Baute auf einem älteren Stand auf.',
  playtime_regressed: 'Weniger Spielzeit als der aktuelle Stand.',
};

export function describeVersion(version: VersionView): string {
  if (version.type === 'konflikt') return 'Konfliktkopie';
  if (version.type === 'import') return 'hat importiert';
  return 'hat gespeichert';
}

/** Warum „Zurückholen“ gerade nicht geht, oder null. */
export function restoreBlockReason(state: AppState | null): string | null {
  if (state === null) return 'Status wird geladen.';
  if (state.host !== null) return 'Geht nur, wenn niemand hostet.';
  if (!state.connection.online) return 'Keine Verbindung zum Server.';
  return null;
}
