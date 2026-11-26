import { describe, expect, it } from 'vitest';
import { Harness, SESSION, seedHead } from './helpers/harness';

describe('SyncEngine – Host-Ablauf (Plan 4.2–4.5)', () => {
  it('Spielen → Lease → Download → Ablegen → Hosten → Upload → Freigeben → Aufräumen', async () => {
    const h = new Harness();
    const head = seedHead(h.server, 1_000);
    await h.start();
    expect(h.state.phase).toBe('bereit');
    expect(h.state.head?.id).toBe(head.id);

    await h.playUntilHosting();
    expect(h.state.phase).toBe('hosten');
    expect(h.opened).toEqual(['steam://rungameid/526870']);
    expect(h.saveFiles()).toEqual([`${SESSION}_SYNC.sav`]);
    expect(h.state.host?.isMe).toBe(true);

    // Autosave → nach 5 s Ruhe hochgeladen
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_300, body: 'a1' });
    await h.advance(8_000);
    await h.engine.idle();
    expect(h.server.head()?.playSeconds).toBe(1_300);

    h.writeSave(`${SESSION}_autosave_1.sav`, { playSeconds: 1_600, body: 'a2' });
    await h.closeGame();
    expect(h.state.phase).toBe('bereit');
    expect(h.server.head()?.playSeconds).toBe(1_600);
    expect(h.server.lease).toBeNull();
    expect(h.saveFiles()).toEqual([]);
    expect(h.journalFile()).toEqual({});
    expect(h.phases()).toEqual([
      'verbinden', 'bereit', 'lease_holen', 'herunterladen', 'vorbereiten', 'spiel_starten', 'hosten',
      'beenden', 'hochladen', 'lease_freigeben', 'aufraeumen', 'bereit',
    ]);
    expect(h.state.lastSaveAgeSec).not.toBeNull();
  });
});
