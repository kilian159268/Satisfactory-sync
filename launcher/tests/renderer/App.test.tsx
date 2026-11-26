import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from './user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import type { AppState, Phase } from '../../src/shared/ipc';
import { ME, OTHER, installApi, makeState } from './helpers';

const MY_HOST = { name: ME, since: new Date().toISOString(), isMe: true };
const OTHER_HOST = { name: OTHER, since: new Date().toISOString(), isMe: false };

/** Erwartete Ansicht je Phase: Titel (null = Skeleton) und Hauptknopf (null = keiner). */
const EXPECTED: Record<
  Phase,
  { state?: Partial<AppState>; title: string | null; button: string | null }
> = {
  verbinden: { title: null, button: 'Verbinde' },
  anmelden: { state: { me: null }, title: 'Anmelden', button: 'Anmelden' },
  bereit: { title: 'Bereit zum Hosten', button: 'Spielen und hosten' },
  lease_holen: { title: 'Hostrecht wird angefragt', button: 'Wird angefragt' },
  herunterladen: {
    state: { progress: 45 },
    title: 'Spielstand wird geladen',
    button: 'Wird geladen',
  },
  vorbereiten: { title: 'Spielstand wird vorbereitet', button: 'Wird vorbereitet' },
  spiel_starten: { title: 'Satisfactory wird gestartet', button: 'Startet' },
  hosten: { state: { host: MY_HOST, gameRunning: true }, title: 'Spiel läuft', button: null },
  mitspieler: { state: { host: OTHER_HOST }, title: `${OTHER} hostet`, button: 'Spiel starten' },
  beenden: { state: { host: MY_HOST }, title: 'Spiel wurde beendet', button: 'Wird abgeschlossen' },
  hochladen: {
    state: { host: MY_HOST, progress: 60 },
    title: 'Fortschritt wird gesichert',
    button: 'Wird hochgeladen',
  },
  lease_freigeben: { title: 'Hostrecht wird freigegeben', button: 'Wird freigegeben' },
  aufraeumen: { title: 'Wird abgeschlossen', button: 'Räumt auf' },
  wartet_auf_netz: { title: 'Warte auf Verbindung', button: 'Erneut verbinden' },
  offline: {
    state: { connection: { online: false, latencyMs: null, nextRetryInSec: 10 } },
    title: 'Server nicht erreichbar',
    button: 'Erneut verbinden',
  },
  fehler: {
    state: { error: 'Download abgebrochen.' },
    title: 'Vorgang abgebrochen',
    button: 'Erneut versuchen',
  },
};

async function renderApp(state: AppState) {
  const handle = installApi(state);
  render(<App />);
  // Warten, bis getState angekommen ist (Fußzeile verlässt den Ladezustand bzw. Login erscheint).
  await waitFor(() => {
    expect(handle.api.getState).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return handle;
}

describe('Aktionsleiste je Phase', () => {
  it.each(Object.entries(EXPECTED) as [Phase, (typeof EXPECTED)[Phase]][])(
    '%s',
    async (phase, expected) => {
      await renderApp(makeState({ phase, ...expected.state }));
      if (expected.title === null) {
        expect(
          screen.getByText('Status wird geladen', { selector: '.visually-hidden' }),
        ).toBeInTheDocument();
      } else {
        expect(
          await screen.findByRole('heading', { level: 1, name: expected.title }),
        ).toBeInTheDocument();
      }
      if (expected.button !== null) {
        expect(screen.getByRole('button', { name: expected.button })).toBeInTheDocument();
      }
    },
  );

  it('Fortschritt wird als progressbar gezeigt', async () => {
    await renderApp(makeState({ phase: 'herunterladen', progress: 45 }));
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText('45 %')).toBeInTheDocument();
  });

  it('busy-Phasen sperren den Hauptknopf', async () => {
    await renderApp(makeState({ phase: 'hochladen', host: MY_HOST }));
    expect(await screen.findByRole('button', { name: 'Wird hochgeladen' })).toBeDisabled();
  });
});

describe('Aktionen', () => {
  it('„Spielen und hosten“ ruft play()', async () => {
    const { api } = await renderApp(makeState());
    await userEvent.click(await screen.findByRole('button', { name: 'Spielen und hosten' }));
    expect(api.play).toHaveBeenCalledTimes(1);
  });

  it('zeigt Ladezustand, solange play() läuft', async () => {
    const { api } = await renderApp(makeState());
    let resolve: (value: { ok: true }) => void = () => undefined;
    api.play.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const button = await screen.findByRole('button', { name: 'Spielen und hosten' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Nur Spiel starten' })).toBeDisabled();
    await act(async () => {
      resolve({ ok: true });
      await Promise.resolve();
    });
    expect(button).toBeEnabled();
  });

  it('zeigt die Fehlermeldung bei ok:false', async () => {
    const { api } = await renderApp(makeState());
    api.play.mockResolvedValueOnce({ ok: false, error: 'Hostrecht ist vergeben.' });
    await userEvent.click(await screen.findByRole('button', { name: 'Spielen und hosten' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Hostrecht ist vergeben.');
  });

  it('zeigt eine allgemeine Meldung, wenn der Aufruf wirft', async () => {
    const { api } = await renderApp(makeState());
    api.play.mockRejectedValueOnce(new Error('ipc kaputt'));
    await userEvent.click(await screen.findByRole('button', { name: 'Spielen und hosten' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keine Antwort vom Launcher');
  });

  it('„Nur Spiel starten“ ruft startGameOnly() und meldet Erfolg', async () => {
    const { api } = await renderApp(makeState());
    await userEvent.click(await screen.findByRole('button', { name: 'Nur Spiel starten' }));
    expect(api.startGameOnly).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Satisfactory wird gestartet.')).toBeInTheDocument();
  });

  it('Host-Knopf gesperrt mit Begründung, wenn das Spiel schon läuft', async () => {
    const { api } = await renderApp(makeState({ gameRunning: true }));
    const button = await screen.findByRole('button', { name: 'Spielen und hosten' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Schließ das Spiel zuerst.');
    expect(button).toHaveAccessibleDescription('Schließ das Spiel zuerst.');
    expect(screen.getByRole('button', { name: 'Nur Spiel starten' })).toBeDisabled();
    await userEvent.click(button);
    expect(api.play).not.toHaveBeenCalled();
  });

  it('Session-Code-Knopf nur, wenn verfügbar', async () => {
    await renderApp(makeState({ phase: 'hosten', host: MY_HOST, gameRunning: true }));
    await screen.findByRole('heading', { name: 'Spiel läuft' });
    expect(screen.queryByRole('button', { name: 'Session-Code kopieren' })).not.toBeInTheDocument();
  });

  it('Session-Code kopieren ruft copySessionCode()', async () => {
    const { api } = await renderApp(
      makeState({ phase: 'hosten', host: MY_HOST, gameRunning: true, sessionCodeAvailable: true }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Session-Code kopieren' }));
    expect(api.copySessionCode).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Session-Code kopiert.')).toBeInTheDocument();
  });

  it('offline: „Erneut verbinden“ ruft retryConnection()', async () => {
    const { api } = await renderApp(
      makeState({
        phase: 'offline',
        connection: { online: false, latencyMs: null, nextRetryInSec: 10 },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Erneut verbinden' }));
    expect(api.retryConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Keine Verbindung, neuer Versuch in 10 s')).toBeInTheDocument();
  });

  it('fehler: zeigt die Fehlermeldung und versucht erneut', async () => {
    const { api } = await renderApp(makeState({ phase: 'fehler', error: 'Download abgebrochen.' }));
    expect(await screen.findByText('Download abgebrochen.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(api.retryConnection).toHaveBeenCalledTimes(1);
  });

  it('Mitspieler: Spiel starten ruft play(), Hilfe klappt auf', async () => {
    const { api } = await renderApp(makeState({ phase: 'mitspieler', host: OTHER_HOST }));
    expect(await screen.findByText('Tritt über die Freundesliste bei.')).toBeInTheDocument();
    const help = screen.getByRole('button', { name: 'Wie trete ich bei?' });
    expect(help).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(help);
    expect(
      screen.getByText(`Spiel starten, Freundesliste öffnen, bei ${OTHER} auf „Beitreten“.`),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hilfe ausblenden' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Spiel starten' }));
    expect(api.play).toHaveBeenCalledTimes(1);
  });

  it('„bereit“ mit fremdem Host zeigt die Mitspieler-Ansicht', async () => {
    await renderApp(makeState({ phase: 'bereit', host: OTHER_HOST }));
    expect(await screen.findByRole('heading', { name: `${OTHER} hostet` })).toBeInTheDocument();
  });
});

describe('Hinweise', () => {
  it('Server-Speicher voll', async () => {
    await renderApp(makeState({ serverDiskFull: true }));
    expect(await screen.findByText(/Server-Speicher ist voll/)).toBeInTheDocument();
  });

  it('alter Save beim Spielende wird gewarnt', async () => {
    await renderApp(makeState({ phase: 'hochladen', host: MY_HOST, lastSaveAgeSec: 12 * 60 }));
    expect(
      await screen.findByText(/Letzter Save vor 12 Min\. Was danach gebaut wurde/),
    ).toHaveClass('tone-error');
  });

  it('frischer Save beim Spielende ist nur Info', async () => {
    await renderApp(makeState({ phase: 'beenden', host: MY_HOST, lastSaveAgeSec: 30 }));
    expect(await screen.findByText('Letzter Save gerade eben.')).toHaveClass('tone-muted');
  });

  it('Heartbeat-Problem beim Hosten', async () => {
    await renderApp(
      makeState({
        phase: 'hosten',
        host: MY_HOST,
        gameRunning: true,
        connection: { online: false, latencyMs: null, nextRetryInSec: 5 },
      }),
    );
    expect(await screen.findByText(/Lebenszeichen kommt nicht an/)).toBeInTheDocument();
  });
});

describe('Rahmen', () => {
  it('Fußzeile: Host und Verbindung', async () => {
    await renderApp(makeState());
    expect(await screen.findByText('Niemand hostet')).toBeInTheDocument();
    expect(screen.getByText('Mit Server verbunden, 24 ms')).toBeInTheDocument();
  });

  it('Fußzeile: fremder Host mit Uhrzeit', async () => {
    await renderApp(makeState({ phase: 'mitspieler', host: OTHER_HOST }));
    expect(
      await screen.findByText(new RegExp(`^${OTHER} hostet seit \\d\\d:\\d\\d$`)),
    ).toBeInTheDocument();
  });

  it('Seitenleiste: Stand und Gruppe', async () => {
    await renderApp(
      makeState({
        host: OTHER_HOST,
        phase: 'mitspieler',
        crew: makeState().crew.map((c) =>
          c.name === OTHER ? { ...c, isHost: true, status: 'im_spiel' } : c,
        ),
      }),
    );
    const aside = await screen.findByRole('complementary', { name: 'Übersicht' });
    expect(within(aside).getByText('128')).toBeInTheDocument();
    expect(within(aside).getByText('412 h 18 min')).toBeInTheDocument();
    expect(within(aside).getByText('2 von 3 online')).toBeInTheDocument();
    expect(within(aside).getByText('Host')).toBeInTheDocument();
    expect(within(aside).getByText('hostet gerade')).toBeInTheDocument();
    expect(within(aside).getByText('zuletzt vor 3 Std.')).toBeInTheDocument();
    expect(within(aside).getAllByText('Du')).toHaveLength(2);
  });

  it('übernimmt State-Pushes', async () => {
    const handle = await renderApp(makeState());
    await screen.findByRole('heading', { name: 'Bereit zum Hosten' });
    act(() => {
      handle.push(makeState({ phase: 'lease_holen' }));
    });
    expect(screen.getByRole('heading', { name: 'Hostrecht wird angefragt' })).toBeInTheDocument();
  });

  it('Reiterwechsel', async () => {
    await renderApp(makeState());
    const nav = screen.getByRole('navigation', { name: 'Bereiche' });
    expect(within(nav).getByRole('button', { name: 'Start' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await userEvent.click(within(nav).getByRole('button', { name: 'Verlauf' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Verlauf' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Verlauf' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('button', { name: 'Start' })).not.toHaveAttribute('aria-current');

    await userEvent.click(within(nav).getByRole('button', { name: 'Einstellungen' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeInTheDocument();

    await userEvent.click(within(nav).getByRole('button', { name: 'Start' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bereit zum Hosten' }),
    ).toBeInTheDocument();
  });

  it('Fensterknöpfe', async () => {
    const { api } = await renderApp(makeState());
    await userEvent.click(screen.getByRole('button', { name: 'Minimieren' }));
    await userEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(api.window.minimize).toHaveBeenCalledTimes(1);
    expect(api.window.close).toHaveBeenCalledTimes(1);
  });

  it('Anmelden: keine Reiter, keine Seitenleiste', async () => {
    await renderApp(makeState({ phase: 'anmelden', me: null }));
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Bereiche' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
