import { describe, expect, it } from 'vitest';
import {
  labelBox,
  pickVisibleLabels,
  type LabelCandidate,
} from '../../src/renderer/lib/map-geometry';

const cluster = (
  key: string,
  x: number,
  y: number,
  size = 20,
  label = '128 Gebäude',
): LabelCandidate => ({
  key,
  kind: 'cluster',
  at: { x, y },
  size,
  label,
});

describe('pickVisibleLabels', () => {
  it('zeigt alle Beschriftungen, wenn genug Platz ist', () => {
    const labels = pickVisibleLabels(
      [cluster('a', 0, 0), cluster('b', 400, 0), cluster('c', 0, 400)],
      1,
    );
    expect([...labels].sort()).toEqual(['a', 'b', 'c']);
  });

  it('blendet bei Überlagerung die Beschriftung des kleineren Markers aus', () => {
    const labels = pickVisibleLabels([cluster('klein', 30, 0, 14), cluster('gross', 0, 0, 24)], 1);
    expect(labels.has('gross')).toBe(true);
    expect(labels.has('klein')).toBe(false);
  });

  it('die Auswahl hat Vorrang vor größeren Markern', () => {
    const labels = pickVisibleLabels(
      [cluster('klein', 30, 0, 14), cluster('gross', 0, 0, 24)],
      1,
      'klein',
    );
    expect(labels.has('klein')).toBe(true);
    expect(labels.has('gross')).toBe(false);
  });

  it('eine Beschriftung verdeckt keinen fremden Marker (auch keinen Spieler)', () => {
    const c = cluster('a', 0, 0, 20);
    const box = labelBox(c, 1);
    const player: LabelCandidate = {
      key: 'p',
      kind: 'player',
      at: { x: 0, y: (box.top + box.bottom) / 2 },
      size: 22,
      label: 'Testspieler A',
    };
    expect(pickVisibleLabels([c, player], 1).has('a')).toBe(false);
  });

  it('Spieler bekommen keine Beschriftung', () => {
    const player: LabelCandidate = {
      key: 'p',
      kind: 'player',
      at: { x: 0, y: 0 },
      size: 22,
      label: 'Testspieler A',
    };
    expect(pickVisibleLabels([player], 1).size).toBe(0);
  });

  it('beim Hineinzoomen (kleinere Skala) haben wieder mehr Beschriftungen Platz', () => {
    const items = [cluster('a', 0, 0, 24), cluster('b', 40, 0, 14)];
    expect(pickVisibleLabels(items, 1).size).toBe(1);
    expect(pickVisibleLabels(items, 0.25).size).toBe(2);
  });
});
