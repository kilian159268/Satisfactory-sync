import { useEffect, useId, useRef, useState } from 'react';
import type { ActionResult, AppState } from '../../shared/ipc';
import { useAction } from '../hooks/useAction';
import {
  describeNotices,
  describePhase,
  type PrimaryAction,
  type PrimaryButton,
  type SecondaryButton,
} from '../lib/phase-view';
import { Skeleton } from './Skeleton';
import { Spinner } from './Spinner';
import './action-bar.css';

interface ActionBarProps {
  state: AppState | null;
}

const PRIMARY_CALLS: Record<PrimaryAction, () => Promise<ActionResult>> = {
  play: () => window.schichtwechsel.play(),
  retry: () => window.schichtwechsel.retryConnection(),
  copySessionCode: () => window.schichtwechsel.copySessionCode(),
};

const PRIMARY_SUCCESS: Partial<Record<PrimaryAction, string>> = {
  copySessionCode: 'Session-Code kopiert.',
};

/** Status links (Titel, Fortschritt, Hinweise), Knöpfe rechts. */
export function ActionBar({ state }: ActionBarProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const action = useAction();
  const reasonId = useId();
  const view = describePhase(state, { helpOpen });
  const notices = describeNotices(state);
  // Eine Meldung gilt für die Phase, die beim Ende der Aktion aktuell war; wechselt die
  // Phase danach, verschwindet sie (der neue Zustand spricht dann für sich).
  const phase = state?.phase ?? null;
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const [notePhase, setNotePhase] = useState(phase);
  const note = action.note !== null && notePhase === phase ? action.note : null;

  const finish = () => {
    setNotePhase(phaseRef.current);
  };

  const runPrimary = (button: PrimaryButton) => {
    if (button.action === null) return;
    const key = button.action;
    void action.run(key, PRIMARY_CALLS[key], PRIMARY_SUCCESS[key]).then(finish);
  };

  const runSecondary = (button: SecondaryButton) => {
    if (button.action === 'toggleHelp') {
      setHelpOpen((open) => !open);
      return;
    }
    void action
      .run(
        'startGameOnly',
        () => window.schichtwechsel.startGameOnly(),
        'Satisfactory wird gestartet.',
      )
      .then(finish);
  };

  const primary = view.primary;
  const primaryPending = primary?.action != null && action.pending === primary.action;
  const secondary = view.secondary;
  const secondaryPending =
    secondary?.action === 'startGameOnly' && action.pending === 'startGameOnly';
  const anyPending = action.pending !== null;
  const reason = primary?.disabledReason ?? null;

  return (
    <section className="action-bar" aria-label="Status und Aktionen">
      <div className="action-bar__status" aria-live="polite">
        {view.title === null ? (
          <div className="action-bar__skeleton" aria-busy="true">
            <span className="visually-hidden">Status wird geladen</span>
            <Skeleton width={180} />
            <Skeleton width={120} small />
          </div>
        ) : (
          <>
            <h1 className="action-bar__title">{view.title}</h1>
            {view.progress !== null && (
              <div className="action-bar__progress">
                <div
                  className="progress"
                  role="progressbar"
                  aria-label={view.title}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={view.progress}
                >
                  <div className="progress__bar" style={{ width: `${view.progress}%` }} />
                </div>
                <span className="action-bar__percent">{view.progress} %</span>
              </div>
            )}
            {note !== null ? (
              <p
                className={
                  note.tone === 'error' ? 'action-bar__sub tone-error' : 'action-bar__sub tone-text'
                }
                role={note.tone === 'error' ? 'alert' : 'status'}
              >
                {note.text}
              </p>
            ) : (
              view.sub !== null && (
                <p
                  id={reason !== null ? reasonId : undefined}
                  className={`action-bar__sub tone-${view.sub.tone}`}
                  role="status"
                >
                  {view.sub.text}
                </p>
              )
            )}
            {notices.length > 0 && (
              <ul className="action-bar__notices">
                {notices.map((n) => (
                  <li key={n.text} className={`tone-${n.tone}`}>
                    {n.text}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="action-bar__buttons">
        {secondary !== null && (
          <button
            type="button"
            className="btn btn--large btn--ghost"
            disabled={secondary.disabledReason !== null || (anyPending && !secondaryPending)}
            aria-busy={secondaryPending || undefined}
            title={secondary.disabledReason ?? undefined}
            aria-expanded={secondary.action === 'toggleHelp' ? helpOpen : undefined}
            onClick={() => {
              if (!secondaryPending) runSecondary(secondary);
            }}
          >
            {secondaryPending && <Spinner />}
            {secondary.label}
          </button>
        )}
        {primary !== null && (
          <PrimaryActionButton
            button={primary}
            pending={primaryPending}
            blocked={anyPending && !primaryPending}
            describedBy={reason !== null && note === null ? reasonId : undefined}
            onClick={() => {
              runPrimary(primary);
            }}
          />
        )}
      </div>
    </section>
  );
}

function PrimaryActionButton({
  button,
  pending,
  blocked,
  describedBy,
  onClick,
}: {
  button: PrimaryButton;
  pending: boolean;
  blocked: boolean;
  describedBy: string | undefined;
  onClick: () => void;
}) {
  const busy = button.variant === 'busy' || pending;
  const variant = busy ? 'btn--busy' : button.variant === 'primary' ? 'btn--primary' : 'btn--ghost';
  const disabled = busy || blocked || button.disabledReason !== null || button.action === null;
  return (
    <button
      type="button"
      className={`btn btn--large btn--main ${variant}`}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
      title={button.disabledReason ?? undefined}
      onClick={onClick}
    >
      {busy && <Spinner />}
      {button.label}
    </button>
  );
}
