import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MapView } from '../../src/renderer/components/MapView';
import { HEAD, OTHER, installApi } from './helpers';
import { userEvent } from './user-event';

async function renderMap() {
  const handle = installApi();
  render(<MapView head={HEAD} live={false} loading={false} />);
  await screen.findByRole('group', { name: 'Karte der Fabrik' });
  return handle;
}

describe('Karte', () => {
  it('lädt die Karte des Heads und zeigt Gebäude, Bahnhöfe, Spieler', async () => {
    const { api } = await renderMap();
    expect(api.getMap).toHaveBeenCalledWith(HEAD.id);
    expect(screen.getByRole('button', { name: '312 Gebäude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bahnhof Nordbahnhof' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OTHER })).toBeInTheDocument();
    expect(screen.getByText('Aus Version 128')).toBeInTheDocument();
  });

  it('Auswahl zeigt die Infokarte, × schließt sie', async () => {
    await renderMap();
    await userEvent.click(screen.getByRole('button', { name: '312 Gebäude' }));
    const info = screen.getByRole('region', { name: 'Auswahl' });
    expect(info).toHaveTextContent('Vor allem Konstruktor und Fertiger.');
    expect(screen.getByRole('button', { name: '312 Gebäude' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Info schließen' }));
    expect(screen.queryByRole('region', { name: 'Auswahl' })).not.toBeInTheDocument();
  });

  it('Spieler-Info nennt die Version', async () => {
    await renderMap();
    await userEvent.click(screen.getByRole('button', { name: OTHER }));
    expect(screen.getByRole('region', { name: 'Auswahl' })).toHaveTextContent(
      'Letzte Position in Version 128.',
    );
  });

  it('Filter blenden Gebäude bzw. Spieler aus', async () => {
    await renderMap();
    const buildings = screen.getByRole('button', { name: 'Gebäude' });
    expect(buildings).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(buildings);
    expect(buildings).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: '312 Gebäude' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bahnhof Nordbahnhof' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Spieler' }));
    expect(screen.queryByRole('button', { name: OTHER })).not.toBeInTheDocument();
  });

  it('Zoom: − ist am Anfang gesperrt, + ändert die viewBox', async () => {
    await renderMap();
    const svg = screen.getByRole('group', { name: 'Karte der Fabrik' });
    const before = svg.getAttribute('viewBox');
    expect(screen.getByRole('button', { name: 'Herauszoomen' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Hineinzoomen' }));
    expect(svg.getAttribute('viewBox')).not.toBe(before);
    expect(screen.getByRole('button', { name: 'Herauszoomen' })).toBeEnabled();
  });

  it('ohne Karte: leerer Zustand mit Hinweis', async () => {
    const { api } = installApi();
    api.getMap.mockResolvedValueOnce(null);
    render(<MapView head={HEAD} live={false} loading={false} />);
    expect(
      await screen.findByText('Für diesen Stand gibt es noch keine Karte.'),
    ).toBeInTheDocument();
  });

  it('ohne Spielstand: Hinweis, kein Aufruf', () => {
    const { api } = installApi();
    render(<MapView head={null} live={false} loading={false} />);
    expect(screen.getByText('Noch kein Spielstand auf dem Server.')).toBeInTheDocument();
    expect(api.getMap).not.toHaveBeenCalled();
  });
});

describe('Karten-Ebenen', () => {
  const terrain = {
    minX: -3247,
    minY: -3750,
    cellSize: 3750,
    cols: 2,
    rows: 2,
    minZ: -10,
    maxZ: 300,
    waterZ: -20,
    heights: btoa(String.fromCharCode(10, 0, 44, 1, 0, 0, 100, 0)),
  };

  it('ohne Gelände: nur „Schematisch“ wählbar, die anderen mit Begründung gesperrt', async () => {
    await renderMap();
    const group = screen.getByRole('group', { name: 'Ebene' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Farbig' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Farbig' })).toHaveAttribute(
      'title',
      'Gelände gibt es ab dem nächsten Upload des Hosts.',
    );
    expect(screen.getByRole('button', { name: 'Schematisch' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('mit Gelände: Standard „Farbig“, Wechsel wird gemerkt', async () => {
    window.localStorage.clear();
    const { api } = installApi();
    const base = await api.getMap(HEAD.id);
    api.getMap.mockResolvedValue(base === null ? null : { ...base, terrain });
    const view = render(<MapView head={HEAD} live={false} loading={false} />);
    await screen.findByRole('group', { name: 'Karte der Fabrik' });
    expect(screen.getByRole('button', { name: 'Farbig' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector('.map--layer-farbig')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Gedämpft' }));
    expect(screen.getByRole('button', { name: 'Gedämpft' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(view.container.querySelector('.map--layer-gedaempft')).not.toBeNull();
    expect(window.localStorage.getItem('v3in-sync.mapLayer')).toBe('gedaempft');
    await userEvent.click(screen.getByRole('button', { name: 'Schematisch' }));
    expect(view.container.querySelector('.map__grid')).not.toBeNull();
  });
});
