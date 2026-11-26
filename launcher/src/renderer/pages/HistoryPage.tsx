import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, VersionView } from '../../shared/ipc';
import { Skeleton } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import { useAction } from '../hooks/useAction';
import { formatDayTime } from '../lib/format';
import { CONFLICT_REASONS, describeVersion, restoreBlockReason } from '../lib/history';
import './pages.css';

interface HistoryPageProps {
  state: AppState | null;
  now: Date;
}

type Load = { status: 'loading' } | { status: 'ok'; versions: VersionView[] } | { status: 'error' };

/** Verlauf: Versionen, Zurückholen mit Bestätigung. */
export function HistoryPage({ state, now }: HistoryPageProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [asking, setAsking] = useState<VersionView | null>(null);
  const action = useAction();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headId = state?.head?.id ?? null;

  const fetchVersions = useCallback(() => {
    let active = true;
    window.schichtwechsel.listVersions().then(
      (versions) => {
        if (active) setLoad({ status: 'ok', versions });
      },
      () => {
        if (active) setLoad({ status: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // Neu laden, wenn sich der Head ändert (z. B. nach Zurückholen oder neuem Upload).
  useEffect(() => fetchVersions(), [fetchVersions, headId]);

  useEffect(() => {
    if (asking !== null) cancelRef.current?.focus();
  }, [asking]);

  const blockReason = restoreBlockReason(state);
  const me = state?.me?.name ?? null;

  const confirm = () => {
    if (asking === null) return;
    const target = asking;
    void action
      .run(
        'restore',
        () => window.schichtwechsel.restoreVersion(target.id),
        `Version ${target.label} ist jetzt aktuell.`,
      )
      .then((ok) => {
        setAsking(null);
        if (ok) fetchVersions();
      });
  };

  return (
    <main className="page page--history">
      <h1 className="page__title">Verlauf</h1>
      <p className="page__lead">Zurückholen geht nur, wenn niemand hostet.</p>

      {asking !== null && (
        <div
          className="confirm"
          role="alertdialog"
          aria-label="Zurückholen bestätigen"
          aria-describedby="confirm-text"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && action.pending === null) setAsking(null);
          }}
        >
          <span id="confirm-text" className="confirm__text">
            Version {asking.label} zurückholen? Der aktuelle Stand bleibt im Verlauf.
          </span>
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            disabled={action.pending !== null}
            onClick={() => {
              setAsking(null);
            }}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className={action.pending !== null ? 'btn btn--busy' : 'btn btn--primary'}
            disabled={action.pending !== null || blockReason !== null}
            title={blockReason ?? undefined}
            aria-busy={action.pending !== null || undefined}
            onClick={confirm}
          >
            {action.pending !== null && <Spinner />}
            Zurückholen
          </button>
        </div>
      )}

      <div aria-live="polite">
        {action.note !== null && (
          <p
            className={`page__note tone-${action.note.tone === 'error' ? 'error' : 'text'}`}
            role={action.note.tone === 'error' ? 'alert' : 'status'}
          >
            {action.note.text}
          </p>
        )}
      </div>

      {load.status === 'loading' && (
        <ul className="versions" aria-busy="true" aria-label="Versionen werden geladen">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="versions__row">
              <Skeleton width={40} />
              <Skeleton width={200} />
            </li>
          ))}
        </ul>
      )}

      {load.status === 'error' && (
        <div className="page__error">
          <p className="tone-error" role="alert">
            Verlauf konnte nicht geladen werden.
          </p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setLoad({ status: 'loading' });
              fetchVersions();
            }}
          >
            Erneut laden
          </button>
        </div>
      )}

      {load.status === 'ok' && load.versions.length === 0 && (
        <p className="page__lead">Noch keine Versionen auf dem Server.</p>
      )}

      {load.status === 'ok' && load.versions.length > 0 && (
        <ul className="versions" aria-label="Versionen">
          {load.versions.map((version) => {
            const who = me !== null && version.uploadedBy === me ? 'Du' : version.uploadedBy;
            const reason =
              version.conflictReason === null
                ? undefined
                : CONFLICT_REASONS[version.conflictReason];
            return (
              <li key={version.id} className="versions__row">
                <span
                  className={version.isHead ? 'versions__num versions__num--head' : 'versions__num'}
                >
                  {version.label}
                </span>
                <span className="versions__what" title={reason}>
                  <span className="versions__who">{who}</span>
                  <span className="versions__verb"> {describeVersion(version)}</span>
                </span>
                <span className="versions__time">{formatDayTime(version.uploadedAt, now)}</span>
                <span className="versions__action">
                  {version.isHead ? (
                    <span className="versions__current">aktuell</span>
                  ) : (
                    <button
                      type="button"
                      className="btn-text"
                      disabled={blockReason !== null}
                      title={blockReason ?? `Version ${version.label} zurückholen`}
                      aria-label={`Version ${version.label} zurückholen`}
                      onClick={() => {
                        action.clear();
                        setAsking(version);
                      }}
                    >
                      Zurückholen
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
