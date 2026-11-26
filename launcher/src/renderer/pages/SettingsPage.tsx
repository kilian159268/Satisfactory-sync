import { useEffect, useId, useState, type SyntheticEvent } from 'react';
import {
  ServerUrlSchema,
  type Platform,
  type Settings,
  type SettingsPatch,
} from '../../shared/ipc';
import { Skeleton } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import { useAction } from '../hooks/useAction';
import { LinkAccess } from '../components/LinkAccess';
import './pages.css';

type Load = { status: 'loading' } | { status: 'ok' } | { status: 'error' };

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'steam', label: 'Steam' },
  { id: 'epic', label: 'Epic Games' },
];

const SAVE_ERROR = 'Einstellung konnte nicht gespeichert werden.';

/** Einstellungen: Plattform, Spielstand-Ordner, Autostart, Server-Adresse. */
export function SettingsPage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverDraft, setServerDraft] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const action = useAction();
  const ids = useId();

  useEffect(() => {
    let active = true;
    window.schichtwechsel.getSettings().then(
      (loaded) => {
        if (!active) return;
        setSettings(loaded);
        setServerDraft(loaded.serverUrl);
        setLoad({ status: 'ok' });
      },
      () => {
        if (active) setLoad({ status: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const save = (key: string, patch: SettingsPatch) => {
    void action.run(key, async () => {
      try {
        const next = await window.schichtwechsel.updateSettings(patch);
        setSettings(next);
        if (patch.serverUrl !== undefined) setServerDraft(next.serverUrl);
        return { ok: true, message: 'Gespeichert.' };
      } catch {
        return { ok: false, error: SAVE_ERROR };
      }
    });
  };

  const submitServer = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = ServerUrlSchema.safeParse(serverDraft.trim());
    if (!parsed.success) {
      setServerError('Bitte eine gültige Adresse mit https:// angeben.');
      return;
    }
    setServerError(null);
    save('serverUrl', { serverUrl: parsed.data });
  };

  if (load.status === 'error') {
    return (
      <main className="page page--settings">
        <h1 className="page__title">Einstellungen</h1>
        <p className="tone-error" role="alert">
          Einstellungen konnten nicht geladen werden.
        </p>
      </main>
    );
  }

  if (settings === null) {
    return (
      <main className="page page--settings" aria-busy="true">
        <h1 className="page__title">Einstellungen</h1>
        <div className="settings__group">
          <Skeleton width={80} />
          <Skeleton width={200} />
        </div>
        <div className="settings__group">
          <Skeleton width={120} />
          <Skeleton width="full" />
        </div>
      </main>
    );
  }

  const pending = action.pending;
  const serverChanged = serverDraft.trim() !== settings.serverUrl;

  return (
    <main className="page page--settings">
      <h1 className="page__title">Einstellungen</h1>

      <fieldset className="settings__group settings__fieldset">
        <legend className="settings__label">Plattform</legend>
        <div className="settings__choices">
          {PLATFORMS.map((platform) => {
            const on = settings.platform === platform.id;
            return (
              <button
                key={platform.id}
                type="button"
                className={on ? 'choice choice--on' : 'choice'}
                aria-pressed={on}
                disabled={pending !== null}
                onClick={() => {
                  if (!on) save('platform', { platform: platform.id });
                }}
              >
                {pending === 'platform' && !on && <Spinner />}
                {platform.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="settings__group">
        <label htmlFor={`${ids}-savedir`} className="settings__label">
          Spielstand-Ordner
        </label>
        <input
          id={`${ids}-savedir`}
          className="field field--readonly"
          type="text"
          readOnly
          value={settings.saveDir ?? ''}
          placeholder="Wird erkannt, sobald das Spiel einmal gespeichert hat."
        />
      </div>

      <label className="settings__check">
        <input
          type="checkbox"
          checked={settings.autostart}
          disabled={pending !== null}
          onChange={(event) => {
            save('autostart', { autostart: event.target.checked });
          }}
        />
        <span>
          <span className="settings__check-title">Mit Windows starten</span>
          <span className="settings__hint">Lädt offene Stände sofort hoch.</span>
        </span>
      </label>

      <form className="settings__group" onSubmit={submitServer} noValidate>
        <label htmlFor={`${ids}-server`} className="settings__label">
          Server-Adresse
        </label>
        <div className="settings__inline">
          <input
            id={`${ids}-server`}
            className="field"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={serverDraft}
            aria-invalid={serverError !== null || undefined}
            aria-describedby={serverError !== null ? `${ids}-server-error` : undefined}
            onChange={(event) => {
              setServerDraft(event.target.value);
              setServerError(null);
            }}
          />
          <button
            type="submit"
            className={pending === 'serverUrl' ? 'btn btn--busy' : 'btn btn--ghost'}
            disabled={pending !== null || !serverChanged}
            title={serverChanged ? undefined : 'Adresse ist unverändert.'}
          >
            {pending === 'serverUrl' && <Spinner />}
            Speichern
          </button>
        </div>
        {serverError !== null && (
          <p id={`${ids}-server-error`} className="settings__hint tone-error" role="alert">
            {serverError}
          </p>
        )}
      </form>

      <LinkAccess />

      <div aria-live="polite">
        {action.note !== null && (
          <p
            className={
              action.note.tone === 'error' ? 'page__note tone-error' : 'page__note tone-muted'
            }
            role={action.note.tone === 'error' ? 'alert' : 'status'}
          >
            {action.note.text}
          </p>
        )}
      </div>
    </main>
  );
}
