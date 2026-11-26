import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';
import { installApi } from './helpers';
import { userEvent } from './user-event';

async function renderSettings() {
  const handle = installApi();
  render(<SettingsPage />);
  await screen.findByRole('group', { name: 'Plattform' });
  return handle;
}

describe('Einstellungen', () => {
  it('zeigt die Einstellungen aus getSettings', async () => {
    await renderSettings();
    expect(screen.getByRole('button', { name: 'Steam' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Epic Games' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const saveDir = screen.getByLabelText('Spielstand-Ordner');
    expect(saveDir).toHaveAttribute('readonly');
    expect(saveDir).toHaveValue('C:\\Spielstände');
    expect(screen.getByRole('checkbox', { name: /Mit Windows starten/ })).not.toBeChecked();
    expect(screen.getByLabelText('Server-Adresse')).toHaveValue('https://sync.v3in.de');
  });

  it('Plattform wechseln ruft updateSettings', async () => {
    const { api } = await renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'Epic Games' }));
    expect(api.updateSettings).toHaveBeenCalledWith({ platform: 'epic' });
    expect(screen.getByRole('button', { name: 'Epic Games' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Gespeichert.');
  });

  it('Autostart umschalten', async () => {
    const { api } = await renderSettings();
    await userEvent.click(screen.getByRole('checkbox', { name: /Mit Windows starten/ }));
    expect(api.updateSettings).toHaveBeenCalledWith({ autostart: true });
    expect(screen.getByRole('checkbox', { name: /Mit Windows starten/ })).toBeChecked();
  });

  it('Fehler beim Speichern wird gemeldet', async () => {
    const { api } = await renderSettings();
    api.updateSettings.mockRejectedValueOnce(new Error('ungültig'));
    await userEvent.click(screen.getByRole('button', { name: 'Epic Games' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Einstellung konnte nicht gespeichert werden.',
    );
    expect(screen.getByRole('button', { name: 'Steam' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Server-Adresse: ungültig wird abgelehnt, gültig gespeichert', async () => {
    const { api } = await renderSettings();
    const input = screen.getByLabelText('Server-Adresse');
    const save = screen.getByRole('button', { name: 'Speichern' });
    expect(save).toBeDisabled();

    await userEvent.clearAndType(input, 'http://beispiel.invalid');
    await userEvent.click(save);
    expect(screen.getByRole('alert')).toHaveTextContent('https://');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(api.updateSettings).not.toHaveBeenCalled();

    await userEvent.clearAndType(input, 'https://sync.beispiel.invalid');
    await userEvent.click(save);
    expect(api.updateSettings).toHaveBeenCalledWith({ serverUrl: 'https://sync.beispiel.invalid' });
  });
});
