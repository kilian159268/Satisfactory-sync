import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HistoryPage } from '../../src/renderer/pages/HistoryPage';
import type { VersionView } from '../../src/shared/ipc';
import { HEAD, ME, OTHER, installApi, makeState } from './helpers';
import { userEvent } from './user-event';

const NOW = new Date(2026, 10, 26, 20, 30);

const VERSIONS: VersionView[] = [
  { ...HEAD, uploadedAt: new Date(2026, 10, 26, 19, 42).toISOString() },
  {
    ...HEAD,
    id: 199,
    label: '127',
    isHead: false,
    uploadedBy: ME,
    uploadedAt: new Date(2026, 10, 25, 23, 10).toISOString(),
  },
  {
    ...HEAD,
    id: 150,
    label: 'K-3',
    isHead: false,
    type: 'konflikt',
    conflictReason: 'stale_token',
    uploadedBy: 'Testspieler C',
    uploadedAt: new Date(2026, 10, 23, 21, 5).toISOString(),
  },
];

async function renderHistory(state = makeState()) {
  const handle = installApi(state);
  handle.api.listVersions.mockResolvedValue(VERSIONS);
  render(<HistoryPage state={state} now={NOW} />);
  await screen.findByRole('list', { name: 'Versionen' });
  return handle;
}

describe('Verlauf', () => {
  it('zeigt Skeleton beim Laden', () => {
    const handle = installApi();
    handle.api.listVersions.mockReturnValue(new Promise(() => undefined));
    render(<HistoryPage state={makeState()} now={NOW} />);
    expect(screen.getByRole('list', { name: 'Versionen werden geladen' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('listet Versionen mit Nummer, wer, was und Zeit', async () => {
    await renderHistory();
    const rows = within(screen.getByRole('list', { name: 'Versionen' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('128');
    expect(rows[0]).toHaveTextContent(`${OTHER} hat gespeichert`);
    expect(rows[0]).toHaveTextContent('heute, 19:42');
    expect(rows[0]).toHaveTextContent('aktuell');
    expect(rows[1]).toHaveTextContent('Du hat gespeichert');
    expect(rows[1]).toHaveTextContent('gestern, 23:10');
    expect(rows[2]).toHaveTextContent('Testspieler C Konfliktkopie');
    expect(rows[2]).toHaveTextContent('Mo, 21:05');
    expect(rows[0]?.querySelector('button')).toBeNull();
  });

  it('Zurückholen mit Bestätigung', async () => {
    const { api } = await renderHistory();
    await userEvent.click(screen.getByRole('button', { name: 'Version 127 zurückholen' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Zurückholen bestätigen' });
    expect(dialog).toHaveTextContent('Version 127 zurückholen?');
    expect(within(dialog).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
    expect(api.restoreVersion).not.toHaveBeenCalled();

    api.restoreVersion.mockResolvedValueOnce({ ok: true });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zurückholen' }));
    expect(api.restoreVersion).toHaveBeenCalledWith(199);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Version 127 ist jetzt aktuell.');
    // Liste wird danach neu geladen.
    expect(api.listVersions).toHaveBeenCalledTimes(2);
  });

  it('Abbrechen schließt die Bestätigung ohne Aufruf', async () => {
    const { api } = await renderHistory();
    await userEvent.click(screen.getByRole('button', { name: 'Version K-3 zurückholen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.restoreVersion).not.toHaveBeenCalled();
  });

  it('zeigt die Fehlermeldung bei ok:false', async () => {
    const { api } = await renderHistory();
    api.restoreVersion.mockResolvedValueOnce({ ok: false, error: 'Jemand hostet gerade.' });
    await userEvent.click(screen.getByRole('button', { name: 'Version 127 zurückholen' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Zurückholen' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Jemand hostet gerade.');
  });

  it('gesperrt mit Begründung, wenn jemand hostet', async () => {
    await renderHistory(
      makeState({ host: { name: OTHER, since: new Date().toISOString(), isMe: false } }),
    );
    const button = screen.getByRole('button', { name: 'Version 127 zurückholen' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Geht nur, wenn niemand hostet.');
  });

  it('Ladefehler mit „Erneut laden“', async () => {
    const handle = installApi();
    handle.api.listVersions.mockRejectedValueOnce(new Error('weg'));
    render(<HistoryPage state={makeState()} now={NOW} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Verlauf konnte nicht geladen werden.',
    );
    handle.api.listVersions.mockResolvedValueOnce(VERSIONS);
    await userEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));
    expect(await screen.findByRole('list', { name: 'Versionen' })).toBeInTheDocument();
  });
});
