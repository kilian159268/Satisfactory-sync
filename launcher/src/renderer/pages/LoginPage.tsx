import { useEffect, useId, useState, type SyntheticEvent } from 'react';
import { DEFAULT_SERVER_URL } from '../../shared/api-types';
import { RedeemInviteInputSchema } from '../../shared/ipc';
import { Spinner } from '../components/Spinner';
import { useAction } from '../hooks/useAction';
import './pages.css';

type Field = 'serverUrl' | 'code' | 'name';

const FIELD_ERRORS: Record<Field, string> = {
  serverUrl: 'Bitte eine gültige Adresse mit https:// angeben.',
  code: 'Bitte den Einladungscode eingeben.',
  name: 'Name: 1 bis 24 Zeichen.',
};

/** Erste Anmeldung mit Einladungscode (Phase „anmelden“). */
export function LoginPage() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const action = useAction();
  const ids = useId();

  // Gespeicherte Server-Adresse vorbelegen, falls schon eine eingestellt ist.
  useEffect(() => {
    let active = true;
    window.schichtwechsel.getSettings().then(
      (settings) => {
        if (active)
          setServerUrl((current) =>
            current === DEFAULT_SERVER_URL ? settings.serverUrl : current,
          );
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (action.pending !== null) return;
    const parsed = RedeemInviteInputSchema.safeParse({ serverUrl: serverUrl.trim(), code, name });
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'serverUrl' || field === 'code' || field === 'name') {
          next[field] =
            field === 'name' && issue.code === 'custom' ? issue.message : FIELD_ERRORS[field];
        }
      }
      setErrors(next);
      return;
    }
    setErrors({});
    const input = parsed.data;
    void action.run('redeem', () => window.schichtwechsel.redeemInvite(input), 'Angemeldet.');
  };

  const fieldProps = (field: Field) => ({
    id: `${ids}-${field}`,
    'aria-invalid': errors[field] !== undefined || undefined,
    'aria-describedby': errors[field] !== undefined ? `${ids}-${field}-error` : undefined,
  });

  const fieldError = (field: Field) =>
    errors[field] === undefined ? null : (
      <p id={`${ids}-${field}-error`} className="login__error tone-error">
        {errors[field]}
      </p>
    );

  const pending = action.pending !== null;

  return (
    <main className="page page--login">
      <form className="login" onSubmit={submit} noValidate aria-labelledby={`${ids}-title`}>
        <div className="login__head">
          <h1 id={`${ids}-title`} className="page__title">
            Anmelden
          </h1>
          <p className="page__lead">Den Einladungscode bekommst du von deiner Gruppe.</p>
        </div>

        <div className="login__field">
          <label htmlFor={`${ids}-serverUrl`} className="settings__label">
            Server-Adresse
          </label>
          <input
            {...fieldProps('serverUrl')}
            className="field"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={serverUrl}
            onChange={(event) => {
              setServerUrl(event.target.value);
            }}
          />
          {fieldError('serverUrl')}
        </div>

        <div className="login__field">
          <label htmlFor={`${ids}-code`} className="settings__label">
            Einladungscode
          </label>
          <input
            {...fieldProps('code')}
            className="field"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
          {fieldError('code')}
        </div>

        <div className="login__field">
          <label htmlFor={`${ids}-name`} className="settings__label">
            Name
          </label>
          <input
            {...fieldProps('name')}
            className="field"
            type="text"
            maxLength={24}
            spellCheck={false}
            autoComplete="nickname"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <p className="settings__hint">
            So sehen dich die anderen in der Gruppe. Bei einem Code für einen zweiten Zugang egal.
          </p>
          {fieldError('name')}
        </div>

        <div className="login__actions">
          <button
            type="submit"
            className={
              pending
                ? 'btn btn--large btn--main btn--busy'
                : 'btn btn--large btn--main btn--primary'
            }
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending && <Spinner />}
            {pending ? 'Wird angemeldet' : 'Anmelden'}
          </button>
        </div>

        <div aria-live="polite">
          {action.note !== null && (
            <p
              className={
                action.note.tone === 'error' ? 'page__note tone-error' : 'page__note tone-text'
              }
              role={action.note.tone === 'error' ? 'alert' : 'status'}
            >
              {action.note.text}
            </p>
          )}
        </div>
      </form>
    </main>
  );
}
