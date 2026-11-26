import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/ipc';

/**
 * Aktueller AppState: erst `getState()`, danach jede Änderung über `onState()`.
 * Ein Push, der vor der getState-Antwort kommt, gewinnt (er ist neuer).
 */
export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    const api = window.schichtwechsel;
    let active = true;
    let pushed = false;
    const unsubscribe = api.onState((next) => {
      pushed = true;
      if (active) setState(next);
    });
    api.getState().then(
      (initial) => {
        if (active && !pushed) setState(initial);
      },
      () => {
        // Kein Zustand vom Main-Prozess: die Oberfläche bleibt im Ladezustand,
        // der nächste Push behebt das.
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}
