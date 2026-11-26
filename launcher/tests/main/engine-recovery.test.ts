/** Absturz in jedem Zustand → Recovery (Plan 4.1 Schritt 2, 4.5, 12). */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../../src/main/ports';
import { SESSION_PHASES } from '../../src/main/sync/state-machine';
import type { Phase } from '../../src/shared/ipc';
import { FakeClock } from './helpers/fake-clock';
import { FakeServer } from './helpers/fake-server';
import { Harness, SESSION, seedHead } from './helpers/harness';

class Crash extends Error {}

/** Harness, deren Engine „stirbt“, sobald `crashAt` erreicht ist: danach scheitert jede Wirkung. */
function crashingHarness() {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  const ctl = { crashed: false, crashAt: null as Phase | null };
  const fetchFn: FetchFn = (url, init) =>
    ctl.crashed ? Promise.reject(new Crash('tot')) : server.fetch(url, init);
  const h = new Harness({
    clock,
    server,
    deps: {
      fetch: fetchFn,
      openExternal: (url) => {
        if (ctl.crashed) return Promise.reject(new Crash('tot'));
        h.opened.push(url);
        h.gameRunning = true;
        return Promise.resolve(true);
      },
    },
  });
  h.fs.hook = () => {
    if (ctl.crashed) throw new Crash('tot');
  };
  h.engine.onStateChange((s) => {
    if (ctl.crashAt !== null && s.phase === ctl.crashAt) ctl.crashed = true;
  });
  const restart = async (): Promise<void> => {
    await h.engine.dispose();
    ctl.crashed = false;
    ctl.crashAt = null;
    h.engine = h.createEngine();
    await h.start();
    await h.engine.idle();
    await h.advance(0);
    await h.engine.idle();
  };
  return { h, ctl, server, restart };
}

/** Normaler Ablauf bis zum Ende; stirbt unterwegs bei `crashAt`. */
async function runSession(h: Harness, ctl: { crashed: boolean }): Promise<void> {
  const p = h.engine.play();
  await h.advance(2_000);
  await p;
  if (ctl.crashed) return;
  h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_500, body: 'a0' });
  await h.advance(8_000);
  await h.engine.idle();
  h.writeSave(`${SESSION}_autosave_1.sav`, { playSeconds: 1_800, body: 'a1' }, h.clock.now() + 1);
  h.gameRunning = false;
  await h.advance(4_000);
  await h.engine.idle();
}

const ORDER: Phase[] = [
  'lease_holen',
  'herunterladen',
  'vorbereiten',
  'spiel_starten',
  'hosten',
  'beenden',
  'hochladen',
  'lease_freigeben',
  'aufraeumen',
];

describe('Absturz in jedem Zustand → Recovery', () => {
  it('deckt alle Session-Phasen ab (wartet_auf_netz eigener Test)', () => {
    expect([...ORDER, 'wartet_auf_netz'].sort()).toEqual([...SESSION_PHASES].sort());
  });

  it.each(ORDER)('Absturz in %s, Spiel danach nicht mehr offen', async (phase) => {
    const { h, ctl, server, restart } = crashingHarness();
    const head = seedHead(server, 1_000);
    await h.start();
    ctl.crashAt = phase;
    await runSession(h, ctl);
    expect(ctl.crashed).toBe(true);
    // Session lief vor dem Absturz bis zu dieser Phase → Journal steht auf ihr
    expect((h.journalFile() as { phase?: string }).phase).toBe(phase);
    if (ORDER.indexOf(phase) >= ORDER.indexOf('hosten')) {
      // Was das Spiel geschrieben hat (auch nach dem Absturz des Launchers)
      h.writeSave(
        `${SESSION}_autosave_1.sav`,
        { playSeconds: 1_800, body: 'a1' },
        h.clock.now() + 1,
      );
    }
    h.gameRunning = false;
    await restart();

    expect(h.state.phase).toBe('bereit');
    expect(h.journalFile()).toEqual({});
    expect(server.activeLease()).toBeNull();
    // nichts mehr vom gemeinsamen Stand im Save-Ordner, nichts gelöscht
    expect(h.saveFiles()).toEqual([]);
    for (const p of h.fs.unlinks)
      expect(p.endsWith('.sav') && !p.includes(join('sync-cache', 'snapshots'))).toBe(false);
    if (ORDER.indexOf(phase) >= ORDER.indexOf('hosten')) {
      expect(server.head()?.playSeconds).toBe(1_800);
      expect(
        server.versions.filter((v) => v.type === 'normal' && v.playSeconds === 1_800),
      ).toHaveLength(1);
    } else {
      expect(server.head()?.id).toBe(head.id);
      expect(h.opened.length).toBeLessThanOrEqual(1);
    }
  });

  it.each(['vorbereiten', 'spiel_starten', 'hosten'] as Phase[])(
    'Absturz in %s, Spiel läuft weiter → weiter hosten',
    async (phase) => {
      const { h, ctl, server, restart } = crashingHarness();
      seedHead(server, 1_000);
      await h.start();
      ctl.crashAt = phase;
      await runSession(h, ctl);
      h.gameRunning = true;
      await restart();
      expect(h.state.phase).toBe('hosten');
      expect(h.state.host?.isMe).toBe(true);
      h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 2_222, body: 'weiter' });
      await h.advance(8_000);
      await h.engine.idle();
      expect(server.head()?.playSeconds).toBe(2_222);
      await h.closeGame();
      expect(h.state.phase).toBe('bereit');
      expect(h.saveFiles()).toEqual([]);
    },
  );

  it('Absturz mitten im Upload (Server hat gespeichert) → Retry mit gleichem Idempotency-Key, eine Version', async () => {
    const clock = new FakeClock();
    const server = new FakeServer(clock);
    let crashed = false;
    let armed = false;
    const fetchFn: FetchFn = async (url, init) => {
      if (crashed) throw new Crash('tot');
      const res = await server.fetch(url, init);
      if (armed && init?.method === 'POST' && url.endsWith('/api/versions')) {
        crashed = true;
        throw new Crash('tot');
      }
      return res;
    };
    const h = new Harness({ clock, server, deps: { fetch: fetchFn } });
    h.fs.hook = () => {
      if (crashed) throw new Crash('tot');
    };
    seedHead(server, 1_000);
    await h.start();
    await h.playUntilHosting();
    armed = true;
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_500, body: 'x' });
    h.gameRunning = false;
    await h.advance(4_000);
    await h.engine.idle();
    expect(crashed).toBe(true);
    const journal = h.journalFile() as { phase: string; pendingUpload: { idempotencyKey: string } };
    expect(journal.phase).toBe('hochladen');
    await h.engine.dispose();
    crashed = false;
    armed = false;
    h.engine = h.createEngine();
    await h.start();
    await h.engine.idle();
    const keys = server.log
      .filter((l) => l.method === 'POST' && l.path === '/api/versions')
      .map((l) => l.headers.get('Idempotency-Key'));
    expect(keys).toEqual([
      journal.pendingUpload.idempotencyKey,
      journal.pendingUpload.idempotencyKey,
    ]);
    expect(server.versions.filter((v) => v.playSeconds === 1_500)).toHaveLength(1);
    expect(h.state.phase).toBe('bereit');
  });

  it('Absturz in wartet_auf_netz, Neustart noch offline → bleibt dort; online → Abschluss', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_600, body: 'x' });
    h.server.offline = true;
    await h.closeGame();
    expect(h.state.phase).toBe('wartet_auf_netz');
    await h.crashAndRestart();
    expect(h.state.phase).toBe('wartet_auf_netz');
    expect(h.saveFiles()).toContain(`${SESSION}_autosave_0.sav`);
    h.server.offline = false;
    await h.advance(60_000);
    await h.engine.idle();
    expect(h.state.phase).toBe('bereit');
    expect(h.server.head()?.playSeconds).toBe(1_600);
  });

  it('Journal vorhanden, Token ungültig → anmelden; nach Anmeldung Recovery', async () => {
    const h = new Harness();
    h.server.invites.set('CODE', true);
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_600, body: 'x' });
    h.gameRunning = false;
    await h.engine.dispose();
    h.server.tokens.clear();
    h.engine = h.createEngine();
    await h.start();
    expect(h.state.phase).toBe('anmelden');
    expect(h.journalFile()).not.toEqual({});
    h.server.tokens.clear();
    const r = await h.engine.redeemInvite({
      code: 'CODE',
      name: 'Anna',
      serverUrl: 'https://sync.test',
    });
    expect(r.ok).toBe(true);
    await h.engine.idle();
    expect(h.state.phase).toBe('bereit');
    expect(h.server.versions.some((v) => v.playSeconds === 1_600)).toBe(true);
  });
});
