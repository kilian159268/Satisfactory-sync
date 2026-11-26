import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoginPage } from '../../src/renderer/pages/LoginPage';
import { installApi } from './helpers';
import { userEvent } from './user-event';

async function renderLogin() {
  const handle = installApi();
  render(<LoginPage />);
  await screen.findByRole('heading', { name: 'Anmelden' });
  return handle;
}

describe('Anmelden', () => {
  it('Server-Adresse ist vorbelegt', async () => {
    await renderLogin();
    expect(screen.getByLabelText('Server-Adresse')).toHaveValue('https://sync.v3in.de');
  });

  it('ruft redeemInvite mit den Eingaben', async () => {
    const { api } = await renderLogin();
    await userEvent.clearAndType(screen.getByLabelText('Einladungscode'), ' ABCD-1234 ');
    await userEvent.clearAndType(screen.getByLabelText('Name'), 'Testspieler A');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(api.redeemInvite).toHaveBeenCalledWith({
      serverUrl: 'https://sync.v3in.de',
      code: 'ABCD-1234',
      name: 'Testspieler A',
    });
  });

  it('zeigt Feldfehler ohne Aufruf', async () => {
    const { api } = await renderLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(screen.getByText('Bitte den Einladungscode eingeben.')).toBeInTheDocument();
    expect(screen.getByText('Name: 1 bis 24 Zeichen.')).toBeInTheDocument();
    expect(screen.getByLabelText('Einladungscode')).toHaveAttribute('aria-invalid', 'true');
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it('lehnt eine Adresse ohne https ab', async () => {
    const { api } = await renderLogin();
    await userEvent.clearAndType(
      screen.getByLabelText('Server-Adresse'),
      'http://beispiel.invalid',
    );
    await userEvent.clearAndType(screen.getByLabelText('Einladungscode'), 'ABCD');
    await userEvent.clearAndType(screen.getByLabelText('Name'), 'Testspieler A');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(
      screen.getByText('Bitte eine gültige Adresse mit https:// angeben.'),
    ).toBeInTheDocument();
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it('zeigt den Serverfehler bei ok:false', async () => {
    const { api } = await renderLogin();
    api.redeemInvite.mockResolvedValueOnce({
      ok: false,
      error: 'Einladungscode ist ungültig oder schon benutzt.',
    });
    await userEvent.clearAndType(screen.getByLabelText('Einladungscode'), 'FALSCH');
    await userEvent.clearAndType(screen.getByLabelText('Name'), 'Testspieler A');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Einladungscode ist ungültig oder schon benutzt.',
    );
  });
});
