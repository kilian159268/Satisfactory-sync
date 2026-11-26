import { describe, expect, it } from 'vitest';
import { describeNotices, describePhase } from '../../src/renderer/lib/phase-view';
import { PHASES } from '../../src/shared/ipc';
import { makeState } from './helpers';

describe('describePhase', () => {
  it('jede Phase hat eine Ansicht mit Titel oder Ladezustand', () => {
    for (const phase of PHASES) {
      const view = describePhase(makeState({ phase }), { helpOpen: false });
      if (phase === 'verbinden') {
        expect(view.title).toBeNull();
        expect(view.primary?.variant).toBe('busy');
      } else {
        expect(view.title, phase).not.toBeNull();
      }
    }
  });

  it('ohne State: Ladezustand', () => {
    expect(describePhase(null, { helpOpen: false }).title).toBeNull();
  });

  it('bereit ohne Head', () => {
    const view = describePhase(makeState({ head: null }), { helpOpen: false });
    expect(view.sub?.text).toBe('Noch kein Spielstand auf dem Server.');
  });

  it('Fortschritt nur, wenn progress gesetzt', () => {
    expect(
      describePhase(makeState({ phase: 'hochladen' }), { helpOpen: false }).progress,
    ).toBeNull();
    expect(
      describePhase(makeState({ phase: 'hochladen', progress: 33.4 }), { helpOpen: false })
        .progress,
    ).toBe(33);
  });
});

describe('describeNotices', () => {
  it('Fehler außerhalb der Fehlerphase wird als Hinweis gezeigt', () => {
    expect(describeNotices(makeState({ error: 'Upload fehlgeschlagen.' }))).toEqual([
      { text: 'Upload fehlgeschlagen.', tone: 'error' },
    ]);
  });
  it('kein Hinweis im Normalfall', () => {
    expect(describeNotices(makeState())).toEqual([]);
  });
});
