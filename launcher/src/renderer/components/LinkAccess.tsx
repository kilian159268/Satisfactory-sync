import { useId, useState } from 'react';
import { formatDayTime } from '../lib/format';
import { Spinner } from './Spinner';

type View =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'code'; code: string; expiresAt: string; copied: boolean }
  | { status: 'error'; error: string };

/**
 * Zweiter Zugang (zweites Spielkonto oder zweiter PC): Code erzeugen, auf dem anderen Konto beim
 * Anmelden eingeben. Beide Zugänge sind in der Gruppe dieselbe Person.
 */
export function LinkAccess() {
  const [view, setView] = useState<View>({ status: 'idle' });
  const ids = useId();

  const create = async () => {
    setView({ status: 'busy' });
    try {
      const r = await window.schichtwechsel.createLinkCode();
      setView(
        r.ok
          ? { status: 'code', code: r.code, expiresAt: r.expiresAt, copied: false }
          : { status: 'error', error: r.error },
      );
    } catch {
      setView({ status: 'error', error: 'Code konnte nicht erzeugt werden.' });
    }
  };

  const copy = async (code: string, expiresAt: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setView({ status: 'code', code, expiresAt, copied: true });
    } catch {
      // Kopieren nicht möglich – der Code steht zum Abschreiben da.
    }
  };

  return (
    <section className="settings__group" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="settings__label">
        Zweiter Zugang
      </h2>
      <p className="settings__hint">
        Für ein zweites Spielkonto oder einen zweiten PC. Code dort beim Anmelden eingeben. Du
        bleibst eine Person in der Gruppe.
      </p>

      {view.status === 'code' ? (
        <div className="link-access__result" aria-live="polite">
          <output className="link-access__code" aria-label="Verknüpfungscode">
            {view.code}
          </output>
          <div className="settings__inline">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                void copy(view.code, view.expiresAt);
              }}
            >
              {view.copied ? 'Kopiert' : 'Kopieren'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                void create();
              }}
            >
              Neuer Code
            </button>
          </div>
          <p className="settings__hint">
            Einmal einlösbar, gültig bis {formatDayTime(view.expiresAt, new Date())}.
          </p>
        </div>
      ) : (
        <div className="settings__inline">
          <button
            type="button"
            className={view.status === 'busy' ? 'btn btn--busy' : 'btn btn--ghost'}
            disabled={view.status === 'busy'}
            onClick={() => {
              void create();
            }}
          >
            {view.status === 'busy' && <Spinner />}
            Code erzeugen
          </button>
        </div>
      )}
      {view.status === 'error' && (
        <p className="settings__hint tone-error" role="alert">
          {view.error}
        </p>
      )}
    </section>
  );
}
