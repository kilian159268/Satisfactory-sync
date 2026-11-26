import { describe, expect, it } from 'vitest';
import { AppStateSchema, type MapData } from '../../src/shared/ipc';
import { Harness, SESSION, seedHead } from './helpers/harness';

const MAP: MapData = {
  version: 1,
  clusters: [],
  stations: [],
  players: [],
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
};

describe('SyncEngine – Anmeldung, Anwesenheit, Verlauf, Einstellungen', () => {
  it('ohne Token → anmelden; Einladung einlösen → bereit; Fehler werden deutsch gemeldet', async () => {
    const h = new Harness({ loggedIn: false });
    h.server.invites.set('GUT', true);
    await h.start();
    expect(h.state.phase).toBe('anmelden');
    expect(
      await h.engine.redeemInvite({ code: 'FALSCH', name: 'Anna', serverUrl: 'https://sync.test' }),
    ).toEqual({
      ok: false,
      error: 'Einladungscode ist ungültig oder schon benutzt.',
    });
    h.server.offline = true;
    expect(
      (await h.engine.redeemInvite({ code: 'GUT', name: 'Anna', serverUrl: 'https://sync.test' }))
        .ok,
    ).toBe(false);
    h.server.offline = false;
    expect(
      await h.engine.redeemInvite({ code: 'GUT', name: 'Anna', serverUrl: 'https://sync.test' }),
    ).toEqual({ ok: true, message: 'Angemeldet als Anna.' });
    expect(h.state.phase).toBe('bereit');
    expect(h.state.me).toEqual({ name: 'Anna' });
    expect(h.fs.text(`${h.userData}/token.bin`)).toBe('enc:token-Anna');
  });

  it('Token vom Server abgelehnt (401) → anmelden', async () => {
    const h = new Harness();
    h.server.tokens.clear();
    await h.start();
    expect(h.state.phase).toBe('anmelden');
    expect(h.state.error).toMatch(/Anmeldung ungültig/);
  });

  it('Anwesenheit alle 30 s (launcher/im_spiel), Crew mit isMe, Antwortzeit gemessen', async () => {
    const h = new Harness();
    h.server.addUser('Bert');
    await h.start();
    expect(h.server.presence.get('Anna')?.status).toBe('launcher');
    const before = h.server.requests('PUT', '/api/presence');
    await h.advance(30_000);
    expect(h.server.requests('PUT', '/api/presence')).toBe(before + 1);
    expect(h.state.crew.find((c) => c.isMe)).toMatchObject({
      name: 'Anna',
      online: true,
      status: 'launcher',
    });
    expect(h.state.crew.find((c) => c.name === 'Bert')).toMatchObject({
      online: false,
      isMe: false,
    });
    expect(h.state.connection).toMatchObject({ online: true, nextRetryInSec: null });
    expect(h.state.connection.latencyMs).toBe(0);
    h.gameRunning = true;
    await h.advance(1_000);
    expect(h.server.presence.get('Anna')?.status).toBe('im_spiel');
  });

  it('Server fällt im Leerlauf weg → offline mit Countdown; kommt zurück → bereit', async () => {
    const h = new Harness();
    await h.start();
    h.server.offline = true;
    await h.advance(30_000);
    expect(h.state.phase).toBe('offline');
    expect(h.state.connection.online).toBe(false);
    h.server.offline = false;
    await h.advance(5_000);
    expect(h.state.phase).toBe('bereit');
  });

  it('Heartbeat alle 20 s während des Hostens', async () => {
    const h = new Harness();
    seedHead(h.server);
    await h.start();
    await h.playUntilHosting();
    const n = h.server.requests('PUT', '/api/lease/heartbeat');
    await h.advance(60_000);
    expect(h.server.requests('PUT', '/api/lease/heartbeat') - n).toBe(3);
    expect(h.server.activeLease()?.user).toBe('Anna');
  });

  it('Verlauf, Zurückholen (nur ohne Host), Karte', async () => {
    const h = new Harness();
    const v1 = seedHead(h.server, 100);
    const v2 = seedHead(h.server, 200);
    await h.start();
    const list = await h.engine.listVersions();
    expect(list.map((v) => [v.id, v.isHead])).toEqual([
      [v2.id, true],
      [v1.id, false],
    ]);
    expect(await h.engine.restoreVersion(v1.id)).toEqual({
      ok: true,
      message: 'Stand 3 ist wieder aktuell.',
    });
    expect(h.state.head?.playSeconds).toBe(100);
    h.server.grantLease('Bert');
    expect(await h.engine.restoreVersion(v2.id)).toEqual({
      ok: false,
      error: 'Gerade hostet jemand.',
    });
    expect(await h.engine.getMap(v1.id)).toBeNull();
    h.server.maps.set(v1.id, MAP);
    expect(await h.engine.getMap(v1.id)).toEqual(MAP);
    h.server.offline = true;
    expect(await h.engine.getMap(v1.id)).toBeNull();
    // offline: letzter bekannter Verlauf
    expect((await h.engine.listVersions()).length).toBe(2);
  });

  it('Einstellungen: speichern, Autostart umsetzen; Session-Code nicht verfügbar', async () => {
    const calls: boolean[] = [];
    const h = new Harness({ deps: { setAutostart: (e) => calls.push(e) } });
    await h.start();
    expect(await h.engine.getSettings()).toMatchObject({
      platform: 'steam',
      serverUrl: 'https://sync.test',
    });
    expect(await h.engine.updateSettings({ autostart: true, platform: 'epic' })).toMatchObject({
      autostart: true,
      platform: 'epic',
    });
    expect(calls).toEqual([true]);
    expect(await h.engine.copySessionCode()).toEqual({
      ok: false,
      error: 'Kein Session-Code verfügbar.',
    });
    expect(h.state.sessionCodeAvailable).toBe(false);
    await h.engine.startGameOnly();
    expect(h.opened).toEqual(['com.epicgames.launcher://apps/Crab?action=launch&silent=true']);
  });

  it('Karte nach erfolgreichem Upload erzeugt und hochgeladen; Fehler stören den Sync nicht', async () => {
    let fail = false;
    const h = new Harness({
      deps: {
        mapGenerator: (path) =>
          fail
            ? Promise.reject(new Error('Parser kaputt'))
            : Promise.resolve({ ...MAP, version: path.length }),
      },
    });
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_100, body: 'm1' });
    await h.advance(8_000);
    await h.engine.idle();
    const id = h.server.headId ?? 0;
    expect(h.server.maps.has(id)).toBe(true);
    fail = true;
    h.writeSave(`${SESSION}_autosave_1.sav`, { playSeconds: 1_200, body: 'm2' });
    await h.closeGame();
    expect(h.server.head()?.playSeconds).toBe(1_200);
    expect(h.server.maps.has(h.server.headId ?? 0)).toBe(false);
    expect(h.state.phase).toBe('bereit');
  });

  it('Steam-Cloud an → Hinweis in der Statuszeile', async () => {
    const roots: string[] = [];
    const h = new Harness({
      deps: {
        detectSteamCloudEnabled: (root) => {
          roots.push(root);
          return Promise.resolve(true);
        },
      },
    });
    await h.start();
    expect(roots).toHaveLength(1);
    expect(h.state.message).toMatch(/Steam-Cloud ist für Satisfactory noch an/);
  });

  it('Allererste Session (Server ohne Stand) → erster neuer Save legt die Session fest', async () => {
    const h = new Harness();
    h.writeSave('Vorher.sav', { sessionName: 'Alt', playSeconds: 5 }, h.clock.now() - 1_000);
    await h.start();
    expect(h.state.head).toBeNull();
    await h.playUntilHosting();
    expect(h.saveFiles()).toEqual(['Vorher.sav']);
    h.writeSave('Neue Welt_autosave_0.sav', { sessionName: 'Neue Welt', playSeconds: 60 });
    await h.advance(8_000);
    await h.engine.idle();
    expect(h.server.sessionName).toBe('Neue Welt');
    expect(h.engine.getJournal()?.sessionName).toBe('Neue Welt');
    await h.closeGame();
    expect(h.saveFiles()).toEqual(['Vorher.sav']);
    expect(h.state.phase).toBe('bereit');
  });

  it('jeder gepushte AppState ist schema-gültig', async () => {
    const h = new Harness();
    seedHead(h.server);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_500 });
    await h.closeGame();
    expect(h.states.length).toBeGreaterThan(10);
    for (const s of h.states) expect(AppStateSchema.safeParse(s).success).toBe(true);
  });
});
