import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freeTarget, readJson, writeFileAtomic, writeJsonAtomic } from '../../src/main/files';
import { syncFileName, sanitizeFileStem } from '../../src/main/game-assumptions';
import { moveFilesTo, placeSyncSave, scanSessionSaves } from '../../src/main/saves/save-files';
import { judgeSave, SaveWatcher, type WatchRules } from '../../src/main/saves/save-watcher';
import type { SessionSave } from '../../src/main/saves/save-files';
import { FakeClock } from './helpers/fake-clock';
import { MemoryFs } from './helpers/memory-fs';
import { buildSave } from './helpers/saves';

const dir = resolve('/saves');
const q = resolve('/ud/quarantine');

describe('Dateien des Spielstands', () => {
  it('findet nur Saves der Session, neueste zuerst; unlesbare bleiben unberührt', async () => {
    const fs = new MemoryFs();
    fs.put(join(dir, 'a.sav'), buildSave({ sessionName: 'S', playSeconds: 10 }), 1);
    fs.put(join(dir, 'b.sav'), buildSave({ sessionName: 'S', playSeconds: 30 }), 2);
    fs.put(join(dir, 'c.sav'), buildSave({ sessionName: 'Andere', playSeconds: 99 }), 3);
    fs.put(join(dir, 'kaputt.sav'), 'xx');
    fs.put(join(dir, 'notiz.txt'), 'x');
    const found = await scanSessionSaves(fs, dir, 'S');
    expect(found.map((s) => s.name)).toEqual(['b.sav', 'a.sav']);
  });

  it('Quarantäne verschiebt nur und löscht nie, auch bei Namenskonflikten', async () => {
    const fs = new MemoryFs();
    const a = buildSave({ sessionName: 'S', playSeconds: 1, body: 'eins' });
    fs.put(join(dir, 'a.sav'), a);
    const moved1 = await moveFilesTo(fs, [join(dir, 'a.sav')], q, 1000, 'test');
    fs.put(join(dir, 'a.sav'), buildSave({ sessionName: 'S', playSeconds: 2, body: 'zwei' }));
    const moved2 = await moveFilesTo(fs, [join(dir, 'a.sav')], q, 1000, 'test');
    expect(fs.unlinks).toEqual([]);
    expect(moved1[0]).not.toBe(moved2[0]);
    expect(fs.list(q)).toHaveLength(2);
    expect(fs.get(moved1[0] ?? '')).toEqual(a);
    expect(fs.list(dir)).toEqual([]);
  });

  it('legt den Server-Stand atomar als <Session>_SYNC.sav mit mtime jetzt ab, ohne Vorhandenes zu überschreiben', async () => {
    const fs = new MemoryFs();
    const src = buildSave({ sessionName: 'S', playSeconds: 5, body: 'server' });
    fs.put('/cache/1.sav', src);
    const old = buildSave({ sessionName: 'S', playSeconds: 4, body: 'alt' });
    fs.put(join(dir, 'S_SYNC.sav'), old, 1);
    const writes: string[] = [];
    fs.hook = (op, p) => {
      if (op === 'copyFile' || op === 'rename') writes.push(`${op}:${p}`);
    };
    const placed = await placeSyncSave(fs, '/cache/1.sav', dir, 'S', q, 5_000_000);
    expect(placed).toBe(join(dir, 'S_SYNC.sav'));
    expect(fs.get(placed)).toEqual(src);
    expect((await fs.stat(placed))?.mtimeMs).toBe(5_000_000);
    // erst Temp-Datei, dann umbenennen
    const lastRename = fs.renames.at(-1);
    expect(lastRename?.from).toBe(join(dir, '.S_SYNC.sav.tmp'));
    expect(fs.list(q).map((p) => fs.get(p))).toEqual([old]);
    expect(fs.unlinks).toEqual([]);
  });

  it('Dateinamen werden für Windows bereinigt', () => {
    expect(syncFileName('A:B/C')).toBe('A_B_C_SYNC.sav');
    expect(sanitizeFileStem('...')).toBe('Spielstand');
  });

  it('atomares Schreiben: Fehler hinterlässt die alte Datei', async () => {
    const fs = new MemoryFs();
    await writeJsonAtomic(fs, '/ud/x.json', { a: 1 });
    fs.hook = (op) => {
      if (op === 'rename') throw new Error('Strom weg');
    };
    await expect(writeFileAtomic(fs, '/ud/x.json', '{"a":2}')).rejects.toThrow('Strom weg');
    fs.hook = null;
    expect(await readJson(fs, '/ud/x.json')).toEqual({ a: 1 });
    expect(fs.list('/ud')).toEqual([resolve('/ud/x.json')]);
    expect(resolve(await freeTarget(fs, '/ud', 'x.json'))).toBe(resolve('/ud/x (2).json'));
  });
});

describe('Save-Watcher (Plan 4.4)', () => {
  const rules: WatchRules = { sessionName: 'S', minPlaySeconds: 100, notBeforeMs: 0 };

  it('Regeln: Sessionname, Spielzeit ≥ zuletzt, ohne Session nur neue Dateien', () => {
    const h = (sessionName: string, playSeconds: number) => ({
      ...buildHeader(sessionName, playSeconds),
    });
    expect(judgeSave(h('S', 100), 0, rules)).toBe('ok');
    expect(judgeSave(h('S', 99), 0, rules)).toBe('playtime_regressed');
    expect(judgeSave(h('X', 500), 0, rules)).toBe('wrong_session');
    expect(
      judgeSave(h('X', 500), 5, { sessionName: null, minPlaySeconds: 0, notBeforeMs: 10 }),
    ).toBe('too_old');
    expect(
      judgeSave(h('X', 500), 15, { sessionName: null, minPlaySeconds: 0, notBeforeMs: 10 }),
    ).toBe('ok');
  });

  function setup() {
    const clock = new FakeClock();
    const fs = new MemoryFs(() => clock.now());
    void fs.mkdir(dir);
    const got: SessionSave[] = [];
    const rejected: string[] = [];
    let current = rules;
    const w = new SaveWatcher(
      fs,
      clock,
      dir,
      () => current,
      (s) => {
        got.push(s);
      },
      (_s, v) => rejected.push(v),
      5_000,
      1_000,
    );
    w.start();
    return { clock, fs, got, rejected, w, setRules: (r: WatchRules) => (current = r) };
  }

  it('meldet erst nach 5 s ohne Änderung, und jeden Stand nur einmal', async () => {
    const { clock, fs, got } = setup();
    fs.put(join(dir, 'S_autosave_0.sav'), buildSave({ sessionName: 'S', playSeconds: 200 }));
    await clock.advance(4_000);
    expect(got).toHaveLength(0);
    // Spiel schreibt noch → Uhr beginnt neu
    fs.put(
      join(dir, 'S_autosave_0.sav'),
      buildSave({ sessionName: 'S', playSeconds: 200, body: 'mehr' }),
    );
    await clock.advance(4_000);
    expect(got).toHaveLength(0);
    await clock.advance(3_000);
    expect(got.map((s) => s.header.playSeconds)).toEqual([200]);
    await clock.advance(20_000);
    expect(got).toHaveLength(1);
  });

  it('ignoriert fremde Sessions, weniger Spielzeit und unlesbare Dateien', async () => {
    const { clock, fs, got, rejected } = setup();
    fs.put(join(dir, 'Anderes.sav'), buildSave({ sessionName: 'Andere', playSeconds: 9999 }));
    fs.put(join(dir, 'S_alt.sav'), buildSave({ sessionName: 'S', playSeconds: 50 }));
    fs.put(join(dir, 'halb.sav'), buildSave({ sessionName: 'S', playSeconds: 500 }).slice(0, 10));
    fs.put(join(dir, 'x.txt'), 'nix');
    await clock.advance(10_000);
    expect(got).toHaveLength(0);
    expect(rejected.sort()).toEqual(['playtime_regressed', 'wrong_session']);
    // halb geschriebene Datei wird fertig → wird gemeldet
    fs.put(join(dir, 'halb.sav'), buildSave({ sessionName: 'S', playSeconds: 500 }));
    await clock.advance(10_000);
    expect(got.map((s) => s.name)).toEqual(['halb.sav']);
  });
});

function buildHeader(sessionName: string, playSeconds: number) {
  return {
    headerVersion: 14,
    saveVersion: 46,
    buildVersion: 1,
    saveName: null,
    mapName: 'm',
    sessionName,
    playSeconds,
    saveDateTicks: 0n,
  };
}
