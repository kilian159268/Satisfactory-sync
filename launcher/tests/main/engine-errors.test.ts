/** Jeder Fehlerfall aus Plan Kapitel 8 (Launcher-Seite) als eigener Test, dazu Plan 4.1/7.4. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../../src/main/ports';
import { FakeClock } from './helpers/fake-clock';
import { FakeServer } from './helpers/fake-server';
import { MemoryFs } from './helpers/memory-fs';
import { Harness, SESSION, seedHead } from './helpers/harness';

function onlyMovedNeverDeleted(h: Harness): void {
  // Saves dürfen nur verschoben werden; unlink nur für eigene Temp-/Teildateien.
  for (const p of h.fs.unlinks) {
    expect(
      p.includes(join('cache', 'downloads')) ||
        p.includes(join('cache', 'snapshots')) ||
        p.endsWith('.tmp'),
    ).toBe(true);
  }
}

describe('Plan Kapitel 8 – Fehlerfälle', () => {
  it('Zwei drücken gleichzeitig „Spielen“ → genau einer hostet, der andere wird Mitspieler', async () => {
    const clock = new FakeClock();
    const server = new FakeServer(clock);
    seedHead(server, 1_000);
    const anna = new Harness({ name: 'Anna', clock, server });
    const bert = new Harness({ name: 'Bert', clock, server, fs: new MemoryFs(() => clock.now()) });
    await anna.start();
    await bert.start();
    const pa = anna.engine.play();
    const pb = bert.engine.play();
    await clock.advance(2_000);
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.ok && rb.ok).toBe(true);
    const phases = [anna.state.phase, bert.state.phase].sort();
    expect(phases).toEqual(['hosten', 'mitspieler']);
    const guest = anna.state.phase === 'mitspieler' ? anna : bert;
    expect(guest.state.message).toMatch(
      /hostet seit \d\d:\d\d – tritt über deine Freundesliste bei/,
    );
    expect(guest.saveFiles()).toEqual([]);
    expect(guest.opened).toEqual(['steam://rungameid/526870']);
    expect(server.requests('POST', '/api/lease')).toBe(2);
    // Mitspieler schließt das Spiel → wieder bereit
    guest.gameRunning = false;
    await clock.advance(4_000);
    await guest.engine.idle();
    expect(guest.state.phase).toBe('bereit');
  });

  it('Doppelklick auf „Spielen“ → nur ein Ablauf, eine Lease-Anfrage', async () => {
    const h = new Harness();
    seedHead(h.server);
    await h.start();
    const p1 = h.engine.play();
    const r2 = await h.engine.play();
    expect(r2).toEqual({ ok: false, error: 'Es läuft bereits ein Vorgang.' });
    await h.advance(2_000);
    expect((await p1).ok).toBe(true);
    expect(h.server.requests('POST', '/api/lease')).toBe(1);
  });

  it('Host-Spiel stürzt ab → neuester Autosave wird hochgeladen → normaler Abschluss', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(
      `${SESSION}_autosave_2.sav`,
      { playSeconds: 1_400, body: 'x' },
      h.clock.now() - 60_000,
    );
    h.writeSave(
      `${SESSION}_autosave_1.sav`,
      { playSeconds: 1_900, body: 'y' },
      h.clock.now() - 30_000,
    );
    // Absturz: Prozess weg, ohne dass der Watcher die Saves schon hochgeladen hat
    await h.closeGame();
    expect(h.server.head()?.playSeconds).toBe(1_900);
    expect(h.state.phase).toBe('bereit');
    expect(h.state.lastSaveAgeSec).toBeGreaterThanOrEqual(30);
    expect(h.server.lease).toBeNull();
    expect(h.saveFiles()).toEqual([]);
    onlyMovedNeverDeleted(h);
  });

  it('Launcher stürzt ab / PC aus → beim nächsten Start Journal → ausstehenden Save hochladen', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 2_000, body: 'neu' });
    h.gameRunning = false; // PC aus: Spiel weg, Launcher weg
    await h.crashAndRestart();
    await h.engine.idle();
    expect(h.server.head()?.playSeconds).toBe(2_000);
    expect(h.state.phase).toBe('bereit');
    expect(h.journalFile()).toEqual({});
    expect(h.saveFiles()).toEqual([]);
  });

  it('PC aus, inzwischen jemand anderes Host gewesen → Konfliktkopie mit Hinweis, Head bleibt', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 2_000, body: 'zombie' });
    h.gameRunning = false;
    await h.engine.dispose();
    // 3 Minuten später: Lease abgelaufen, Bert hat gehostet und hochgeladen
    await h.advance(180_000);
    h.server.grantLease('Bert');
    const bertHead = seedHead(h.server, 5_000);
    h.server.lease = null;
    h.engine = h.createEngine();
    await h.start();
    await h.engine.idle();
    expect(h.server.head()?.id).toBe(bertHead.id);
    const conflict = h.server.versions.find((v) => v.type === 'konflikt');
    expect(conflict?.playSeconds).toBe(2_000);
    expect(h.state.phase).toBe('bereit');
    expect(h.state.message).toMatch(/Konfliktkopie K-1/);
  });

  it('Internet beim Host weg, Spiel läuft weiter → Warnung; nach Ablauf anderer Host; späterer Upload → Konfliktkopie', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.server.offline = true;
    await h.advance(21_000);
    expect(h.state.connection.online).toBe(false);
    expect(h.state.error).toMatch(/Keine Verbindung zum Server/);
    expect(h.state.phase).toBe('hosten');
    // Lease läuft ab, Bert wird Host und lädt hoch
    await h.advance(120_000);
    h.server.offline = false;
    h.server.grantLease('Bert');
    const bert = seedHead(h.server, 3_000);
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_500, body: 'spaet' });
    await h.advance(8_000);
    await h.engine.idle();
    expect(h.server.head()?.id).toBe(bert.id);
    expect(h.server.versions.find((v) => v.type === 'konflikt')?.conflictReason).toBe(
      'stale_token',
    );
    expect(h.state.error).toMatch(/Konfliktkopie/);
    await h.closeGame();
    expect(h.server.head()?.id).toBe(bert.id);
    expect(h.state.phase).toBe('bereit');
  });

  it('Heartbeat meldet lease_lost → Hinweis, Uploads werden Konfliktkopien', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.server.grantLease('Bert'); // Anna verliert die Lease
    await h.advance(21_000);
    expect(h.state.error).toMatch(/Hostrecht verloren/);
    expect(h.engine.getJournal()?.leaseLost).toBe(true);
  });

  it('Upload bricht ab (Antwort verloren) → Retry mit gleichem Idempotency-Key, genau eine Version', async () => {
    let drop = 1;
    const clock = new FakeClock();
    const server = new FakeServer(clock);
    const lossy: FetchFn = async (url, init) => {
      const res = await server.fetch(url, init);
      if (init?.method === 'POST' && url.endsWith('/api/versions') && drop > 0) {
        drop--;
        throw new TypeError('Verbindung abgebrochen');
      }
      return res;
    };
    const h = new Harness({ clock, server, deps: { fetch: lossy } });
    seedHead(server, 1_000);
    await h.start();
    await h.playUntilHosting();
    const before = server.versions.length;
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_200, body: 'a' });
    await h.advance(8_000);
    await h.engine.idle();
    // erster Versuch: Server hat gespeichert, Antwort ging verloren → Datei bleibt, Pending im Journal
    expect(h.engine.getJournal()?.pendingUpload).not.toBeNull();
    expect(h.saveFiles()).toContain(`${SESSION}_autosave_0.sav`);
    await h.advance(15_000);
    await h.engine.idle();
    const keys = server.log
      .filter((l) => l.method === 'POST' && l.path === '/api/versions')
      .map((l) => l.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(server.versions.length).toBe(before + 1);
    expect(h.engine.getJournal()?.pendingUpload).toBeNull();
    expect(h.engine.getJournal()?.baseVersionId).toBe(server.headId);
  });

  it('Download kaputt (SHA-256 falsch) → neu laden, dann Abbruch; nichts im Save-Ordner, Lease zurück', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    h.writeSave('Anderes.sav', { sessionName: 'Andere Welt', playSeconds: 5 });
    await h.start();
    h.server.corruptDownloads = true;
    const p = h.engine.play();
    await h.advance(10_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/SHA-256/);
    expect(h.server.requests('GET', `/api/versions/${h.server.headId}/file`)).toBe(3);
    expect(h.saveFiles()).toEqual(['Anderes.sav']);
    expect(h.opened).toEqual([]);
    expect(h.server.activeLease()).toBeNull();
    expect(h.state.phase).toBe('bereit');
    expect(h.journalFile()).toEqual({});
  });

  it('Download bricht ab → Range-Resume beim nächsten Versuch', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000, { body: 'z'.repeat(100_000) });
    await h.start();
    h.server.cutNextDownloadAt = 40_000;
    await h.playUntilHosting();
    const gets = h.server.log.filter((l) => l.path.endsWith('/file'));
    expect(gets).toHaveLength(2);
    expect(gets[1]?.headers.get('Range')).toBe('bytes=40000-');
    expect(h.state.phase).toBe('hosten');
  });

  it('Save von neuerer Spielversion → klare Meldung, Lease zurück, Save-Ordner unberührt', async () => {
    const h = new Harness({ installedBuild: 400_000 });
    seedHead(h.server, 1_000, { buildVersion: 420_000 });
    h.writeSave(`${SESSION}_alt.sav`, { playSeconds: 900, body: 'eigen' }, h.clock.now() - 1);
    // Konfliktprüfung beim Öffnen räumt eigene ältere Stände weg; hier interessiert der Host-Start
    await h.start();
    h.writeSave(`${SESSION}_alt.sav`, { playSeconds: 900, body: 'eigen' });
    const r = await h.engine.play();
    expect(r).toEqual({
      ok: false,
      error:
        'Der Spielstand ist mit einer neueren Spielversion gespeichert. Bitte Satisfactory updaten.',
    });
    expect(h.server.activeLease()).toBeNull();
    expect(h.server.requests('DELETE', '/api/lease')).toBe(1);
    expect(h.opened).toEqual([]);
    expect(h.state.error).toMatch(/neueren Spielversion/);
    expect(h.state.phase).toBe('bereit');
    expect(h.fs.list(h.saveDir).some((p) => p.endsWith('_SYNC.sav'))).toBe(false);
  });

  it('Host lädt im Spiel einen anderen Spielstand → wird nicht hochgeladen', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave('Testwelt_autosave_0.sav', { sessionName: 'Testwelt', playSeconds: 99_999 });
    await h.advance(10_000);
    await h.closeGame();
    expect(h.server.versions).toHaveLength(1);
    expect(h.server.requests('POST', '/api/versions')).toBe(0);
    expect(h.saveFiles()).toEqual(['Testwelt_autosave_0.sav']);
  });

  it('Server nicht erreichbar → Host werden nicht möglich (klare Meldung), Mitspieler-Start geht', async () => {
    const h = new Harness();
    h.server.offline = true;
    await h.start();
    expect(h.state.phase).toBe('offline');
    expect(h.state.connection).toEqual({ online: false, latencyMs: null, nextRetryInSec: 5 });
    const r = await h.engine.play();
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/Server nicht erreichbar.*Nur Spiel starten/);
    expect(await h.engine.startGameOnly()).toMatchObject({ ok: true });
    expect(h.opened).toEqual(['steam://rungameid/526870']);
    // Countdown, dann neuer Versuch
    await h.advance(2_000);
    expect(h.state.connection.nextRetryInSec).toBe(3);
    h.server.offline = false;
    await h.advance(3_000);
    expect(h.state.phase).toBe('bereit');
    expect(h.state.connection.online).toBe(true);
    expect(h.state.connection.latencyMs).not.toBeNull();
  });

  it('Server weg beim Lease-Holen → offline mit Meldung, kein Journal', async () => {
    const h = new Harness();
    seedHead(h.server);
    await h.start();
    h.server.offline = true;
    const r = await h.engine.play();
    expect(r.ok).toBe(false);
    expect(h.state.phase).toBe('offline');
    expect(h.journalFile()).toEqual({});
  });

  it('Spiel lief schon vor dem Launcher → Host-Knopf gesperrt', async () => {
    const h = new Harness();
    seedHead(h.server);
    h.gameRunning = true;
    await h.start();
    expect(h.state.gameRunning).toBe(true);
    const r = await h.engine.play();
    expect(r).toEqual({
      ok: false,
      error: 'Satisfactory läuft schon. Schließ das Spiel zuerst, dann kannst du hosten.',
    });
    expect(h.server.requests('POST', '/api/lease')).toBe(0);
    expect(await h.engine.startGameOnly()).toEqual({
      ok: false,
      error: 'Das Spiel läuft bereits.',
    });
  });

  it('Festplatte des Servers voll → Upload abgelehnt, Save bleibt lokal, Warnung; später hochgeladen', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.server.diskFull = true;
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_500, body: 'voll' });
    await h.advance(8_000);
    await h.engine.idle();
    expect(h.state.serverDiskFull).toBe(true);
    expect(h.state.error).toMatch(/Festplatte des Servers ist voll/);
    await h.closeGame();
    expect(h.state.phase).toBe('wartet_auf_netz');
    expect(h.saveFiles()).toContain(`${SESSION}_autosave_0.sav`);
    expect(h.server.activeLease()?.user).toBe('Anna');
    h.server.diskFull = false;
    await h.advance(30_000);
    await h.engine.idle();
    expect(h.state.phase).toBe('bereit');
    expect(h.state.serverDiskFull).toBe(false);
    expect(h.server.head()?.playSeconds).toBe(1_500);
    expect(h.saveFiles()).toEqual([]);
  });

  it('Kein Internet beim Spielende → Journal bleibt, Dateien bleiben, später Abschluss', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    await h.start();
    await h.playUntilHosting();
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 1_700, body: 'ende' });
    h.server.offline = true;
    await h.closeGame();
    expect(h.state.phase).toBe('wartet_auf_netz');
    expect(h.state.message).toMatch(/bleibt auf diesem PC/);
    expect((h.journalFile() as { phase: string }).phase).toBe('wartet_auf_netz');
    expect(h.saveFiles()).toContain(`${SESSION}_autosave_0.sav`);
    expect(h.state.connection.nextRetryInSec).not.toBeNull();
    h.server.offline = false;
    const r = await h.engine.retryConnection();
    expect(r.ok).toBe(true);
    await h.engine.idle();
    expect(h.state.phase).toBe('bereit');
    expect(h.server.head()?.playSeconds).toBe(1_700);
  });
});

describe('Plan 4.1 Schritt 5 und 7.4 – fremde Stände beim Öffnen', () => {
  it('Saves des gemeinsamen Stands bei Nicht-Host → Quarantäne (verschoben, nicht gelöscht)', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    const old = h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 800, body: 'cloud' });
    h.writeSave('Eigene Welt.sav', { sessionName: 'Eigene Welt', playSeconds: 50 });
    await h.start();
    expect(h.saveFiles()).toEqual(['Eigene Welt.sav']);
    const moved = h.fs.list(join(h.userData, 'quarantine'));
    expect(moved).toHaveLength(1);
    expect(h.fs.get(moved[0] ?? '')).toEqual(old);
    expect(h.fs.unlinks).toEqual([]);
  });

  it('Lokaler Stand mit mehr Spielzeit → als Konfliktkopie hochgeladen und gemeldet', async () => {
    const h = new Harness();
    const head = seedHead(h.server, 1_000);
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 4_000, body: 'mehr' });
    await h.start();
    const conflict = h.server.versions.find((v) => v.type === 'konflikt');
    expect(conflict).toMatchObject({ playSeconds: 4_000, conflictReason: 'no_lease' });
    expect(h.server.head()?.id).toBe(head.id);
    expect(h.state.message).toMatch(/Konfliktkopie K-1/);
    expect(h.saveFiles()).toEqual([]);
  });

  it('Konfliktkopie nicht hochladbar → Datei bleibt liegen, nächster Versuch beim nächsten Öffnen', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 4_000, body: 'mehr' });
    h.server.interceptors.push((r) =>
      r.method === 'POST' && r.path === '/api/versions' ? 'network' : undefined,
    );
    await h.start();
    expect(h.saveFiles()).toEqual([`${SESSION}_autosave_0.sav`]);
    h.server.interceptors.length = 0;
    await h.crashAndRestart();
    expect(h.server.versions.some((v) => v.type === 'konflikt')).toBe(true);
    expect(h.saveFiles()).toEqual([]);
  });

  it('Läuft das Spiel (z. B. „Nur Spiel starten“), wird nichts verschoben – erst nach Spielende', async () => {
    const h = new Harness();
    seedHead(h.server, 1_000);
    h.gameRunning = true;
    h.writeSave(`${SESSION}_autosave_0.sav`, { playSeconds: 900 });
    await h.start();
    expect(h.saveFiles()).toHaveLength(1);
    h.gameRunning = false;
    await h.advance(4_000);
    await h.engine.idle();
    expect(h.saveFiles()).toEqual([]);
  });
});
