import { describe, expect, it } from 'vitest';
import {
  parseSaveHeader,
  readSaveHeader,
  SaveHeaderError,
  tryReadSaveHeader,
} from '../../src/main/saves/save-header';
import { buildSave } from './helpers/saves';
import { MemoryFs } from './helpers/memory-fs';

describe('Save-Header-Parser (Plan 6.3, Annahme Kapitel 14)', () => {
  it('liest Header v14 (mit SaveName)', () => {
    const h = parseSaveHeader(
      buildSave({
        headerVersion: 14,
        saveVersion: 46,
        buildVersion: 416835,
        saveName: 'Mein Save',
        sessionName: 'Fabrik',
        playSeconds: 12345,
        saveTicks: 638000000000000001n,
      }),
    );
    expect(h).toEqual({
      headerVersion: 14,
      saveVersion: 46,
      buildVersion: 416835,
      saveName: 'Mein Save',
      mapName: 'Persistent_Level',
      sessionName: 'Fabrik',
      playSeconds: 12345,
      saveDateTicks: 638000000000000001n,
    });
  });

  it('liest Header v13 (ohne SaveName)', () => {
    const h = parseSaveHeader(buildSave({ headerVersion: 13, sessionName: 'Alt', playSeconds: 7 }));
    expect(h.saveName).toBeNull();
    expect(h.sessionName).toBe('Alt');
    expect(h.playSeconds).toBe(7);
  });

  it('liest UTF-16-Zeichenketten (negative Länge)', () => {
    const h = parseSaveHeader(
      buildSave({ sessionName: 'Fabrik Süd ✓ 工場', playSeconds: 1, utf16: true }),
    );
    expect(h.sessionName).toBe('Fabrik Süd ✓ 工場');
    expect(h.saveName).toBe('Fabrik Süd ✓ 工場');
  });

  it('liest 8-Bit-Zeichen als Latin-1 wie der Server', () => {
    expect(parseSaveHeader(buildSave({ sessionName: 'Größe', playSeconds: 1 })).sessionName).toBe(
      'Größe',
    );
  });

  it('wirft bei abgeschnittenem Header an jeder Stelle', () => {
    const full = buildSave({ sessionName: 'Fabrik', playSeconds: 5, body: '' });
    for (let len = 0; len < full.length; len++) {
      expect(() => parseSaveHeader(full.slice(0, len))).toThrow(SaveHeaderError);
    }
    expect(() => parseSaveHeader(full)).not.toThrow();
  });

  it('lehnt unbekannte Header-Version, leeren Sessionnamen und zu lange Strings ab', () => {
    expect(() =>
      parseSaveHeader(buildSave({ headerVersion: 0, sessionName: 'x', playSeconds: 1 })),
    ).toThrow(/Header-Version/);
    expect(() =>
      parseSaveHeader(buildSave({ headerVersion: 999, sessionName: 'x', playSeconds: 1 })),
    ).toThrow(/Header-Version/);
    expect(() => parseSaveHeader(buildSave({ sessionName: '', playSeconds: 1 }))).toThrow(
      /Sessionname/,
    );
    expect(() => parseSaveHeader(buildSave({ sessionName: 'x', playSeconds: -1 }))).toThrow(
      /Unplausible/,
    );
    const bad = buildSave({ sessionName: 'x', playSeconds: 1 });
    new DataView(bad.buffer).setInt32(12, 100_000, true);
    expect(() => parseSaveHeader(bad)).toThrow(/zu lang/);
    new DataView(bad.buffer).setInt32(12, -2147483648, true);
    expect(() => parseSaveHeader(bad)).toThrow(/zu lang/);
  });

  it('liest nur den Dateianfang', async () => {
    const fs = new MemoryFs();
    const big = new Uint8Array(5_000_000);
    big.set(buildSave({ sessionName: 'Groß', playSeconds: 3, body: '' }));
    fs.put('/s/a.sav', big);
    let requested = 0;
    const orig = fs.readHead.bind(fs);
    fs.readHead = (p, n) => {
      requested = n;
      return orig(p, n);
    };
    expect((await readSaveHeader(fs, '/s/a.sav')).sessionName).toBe('Groß');
    expect(requested).toBeLessThanOrEqual(64 * 1024);
    fs.put('/s/kaputt.sav', 'nix');
    expect(await tryReadSaveHeader(fs, '/s/kaputt.sav')).toBeNull();
    expect(await tryReadSaveHeader(fs, '/s/fehlt.sav')).toBeNull();
  });
});
