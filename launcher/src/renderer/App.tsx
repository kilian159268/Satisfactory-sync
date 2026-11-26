/** Platzhalter des Fundaments. Die eigentliche Oberfläche baut der UI-Agent. */
import { useEffect, useState } from 'react';
import type { Phase } from '../shared/ipc';

export function App() {
  const [phase, setPhase] = useState<Phase | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.schichtwechsel.onState((state) => {
      setPhase(state.phase);
    });
    void window.schichtwechsel.getState().then((state) => {
      if (active) setPhase(state.phase);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <main style={{ padding: 'var(--space-24)' }}>
      <h1 style={{ fontSize: 'var(--font-size-20)', fontWeight: 600, margin: 0 }}>
        Schichtwechsel
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }} data-testid="phase">
        {phase ?? 'lädt …'}
      </p>
    </main>
  );
}
