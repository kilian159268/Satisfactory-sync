import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsStore, DEFAULT_SETTINGS } from '../../src/main/storage/settings-store';
import { TokenStore } from '../../src/main/storage/token-store';
import { JournalStore, type Journal } from '../../src/main/sync/journal';
import type { SecretCipher } from '../../src/main/ports';
import { fakeCipher } from './helpers/harness';
import { MemoryFs } from './helpers/memory-fs';

const ud = resolve('/ud');

describe('Token-Speicher (safeStorage)', () => {
  it('speichert verschlüsselt und liest wieder', async () => {
    const fs = new MemoryFs();
    await new TokenStore(fs, fakeCipher, ud).save('geheim');
    expect(fs.text(join(ud, 'token.bin'))).toBe('enc:geheim');
    expect(await new TokenStore(fs, fakeCipher, ud).load()).toBe('geheim');
  });

  it('ohne Verschlüsselung nichts auf die Platte, kaputt → null, clear vergisst', async () => {
    const fs = new MemoryFs();
    const off: SecretCipher = { ...fakeCipher, isAvailable: () => Promise.resolve(false) };
    const store = new TokenStore(fs, off, ud);
    await store.save('geheim');
    expect(fs.list(ud)).toEqual([]);
    expect(await store.load()).toBe('geheim');
    fs.put(join(ud, 'token.bin'), 'müll');
    expect(await new TokenStore(fs, fakeCipher, ud).load()).toBeNull();
    const s2 = new TokenStore(fs, fakeCipher, ud);
    await s2.save('x');
    await s2.clear();
    expect(await new TokenStore(fs, fakeCipher, ud).load()).toBeNull();
  });
});

describe('Einstellungen', () => {
  it('Standardwerte, atomar gespeichert, kaputte Felder fallen zurück', async () => {
    const fs = new MemoryFs();
    const s = new SettingsStore(fs, ud);
    expect(await s.load()).toEqual(DEFAULT_SETTINGS);
    await s.update({ platform: 'epic', autostart: true });
    expect(await new SettingsStore(fs, ud).load()).toMatchObject({ platform: 'epic', autostart: true });
    fs.put(join(ud, 'settings.json'), JSON.stringify({ serverUrl: 'ftp://x', platform: 'steam' }));
    expect(await new SettingsStore(fs, ud).load()).toMatchObject({ serverUrl: DEFAULT_SETTINGS.serverUrl, platform: 'steam' });
    fs.put(join(ud, 'settings.json'), '{kaputt');
    expect(await new SettingsStore(fs, ud).load()).toEqual(DEFAULT_SETTINGS);
    await expect(s.update({ serverUrl: 'http://evil.example' })).rejects.toThrow();
  });
});

describe('Journal', () => {
  const j: Journal = {
    v: 1, phase: 'hosten', startedAt: 1, leaseId: 'l', fencingToken: 3, baseVersionId: 7, sessionName: 'S',
    platform: 'steam', saveDir: '/s', placedFile: null, placedSha256: null, lastPlaySeconds: 10,
    confirmedSha256: [], rejectedSha256: [], pendingUpload: null, leaseLost: false, notice: null,
  };
  it('speichert, lädt, leert (ohne zu löschen)', async () => {
    const fs = new MemoryFs();
    const store = new JournalStore(fs, ud);
    expect(await store.load()).toBeNull();
    await store.save(j);
    expect(await new JournalStore(fs, ud).load()).toEqual(j);
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(fs.has(store.path)).toBe(true);
    expect(fs.unlinks).toEqual([]);
  });
  it('kaputtes oder ungültiges Journal gilt als keins', async () => {
    const fs = new MemoryFs();
    const store = new JournalStore(fs, ud);
    fs.put(store.path, '{"v":1,"phase":"quatsch"}');
    expect(await store.load()).toBeNull();
    fs.put(store.path, 'nicht json');
    expect(await store.load()).toBeNull();
  });
});
