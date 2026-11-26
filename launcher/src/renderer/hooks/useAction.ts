import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../../shared/ipc';
import type { Tone } from '../lib/phase-view';

export interface ActionNote {
  text: string;
  tone: Tone;
  /** Kennung der Aktion, die die Meldung erzeugt hat. */
  key: string;
}

export interface ActionRunner {
  /** Kennung der laufenden Aktion oder null. */
  pending: string | null;
  note: ActionNote | null;
  run(key: string, call: () => Promise<ActionResult>, successText?: string): Promise<boolean>;
  clear(): void;
}

export const UNEXPECTED_ERROR = 'Keine Antwort vom Launcher. Bitte erneut versuchen.';

/**
 * Führt eine Aktion mit ActionResult aus: Ladezustand während des Aufrufs, danach eine
 * Erfolgs- oder Fehlermeldung. Wirft der Aufruf, wird eine allgemeine Meldung gezeigt.
 */
export function useAction(): ActionRunner {
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<ActionNote | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (key: string, call: () => Promise<ActionResult>, successText?: string) => {
      setPending(key);
      setNote(null);
      let result: ActionResult;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: UNEXPECTED_ERROR };
      }
      if (!mounted.current) return result.ok;
      setPending(null);
      if (result.ok) {
        const text = result.message ?? successText;
        setNote(text === undefined ? null : { text, tone: 'muted', key });
      } else {
        setNote({ text: result.error, tone: 'error', key });
      }
      return result.ok;
    },
    [],
  );

  const clear = useCallback(() => {
    setNote(null);
  }, []);

  return { pending, note, run, clear };
}
