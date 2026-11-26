import type { AppState } from '../../shared/ipc';
import { ActionBar } from '../components/ActionBar';
import { MapView } from '../components/MapView';

/** Startseite: Karte oben, Aktionsleiste darunter. */
export function StartPage({ state }: { state: AppState | null }) {
  const live = state !== null && state.gameRunning && state.host !== null;
  return (
    <>
      <MapView head={state?.head ?? null} live={live} loading={state === null} />
      <ActionBar state={state} />
    </>
  );
}
