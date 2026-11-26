import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectForAccount,
  detectSteamCloudEnabled,
  mostRecentAccountId,
  type CloudFs,
} from '../../../src/main/cloud';

const STEAM = join('C:', 'Steam');
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

/** Dateisystem im Speicher: Pfade relativ zum Steam-Ordner, Ordner ergeben sich aus den Dateien. */
function memoryFs(files: Record<string, string>): CloudFs {
  const abs = new Map(Object.entries(files).map(([rel, text]) => [join(STEAM, rel), text]));
  const missing = (path: string): Error =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    readFile(path) {
      const text = abs.get(path);
      return text === undefined ? Promise.reject(missing(path)) : Promise.resolve(text);
    },
    readdir(path) {
      const prefix = path + sep;
      const names = new Set<string>();
      for (const file of abs.keys()) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split(/[\\/]/)[0] ?? '');
      }
      return names.size === 0 ? Promise.reject(missing(path)) : Promise.resolve([...names]);
    },
  };
}

const shared = (account: string): string =>
  join('userdata', account, '7', 'remote', 'sharedconfig.vdf');
const local = (account: string): string => join('userdata', account, 'config', 'localconfig.vdf');
const LOGINUSERS = join('config', 'loginusers.vdf');

function appBlock(store: string, body: string, steamExtra = ''): string {
  return `"${store}" { "Software" { "Valve" { "Steam" { ${steamExtra} "apps" { "526870" { ${body} } } } } } }`;
}

describe('detectSteamCloudEnabled', () => {
  it('erkennt „aus“ über sharedconfig.vdf (Schalter in den Spiel-Eigenschaften)', async () => {
    const fs = memoryFs({
      [shared('100')]: fixture('sharedconfig-cloud-off.vdf'),
      [local('100')]: fixture('localconfig.vdf'),
    });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(false);
  });

  it('erkennt „an“, wenn der Schalter auf 1 steht', async () => {
    const fs = memoryFs({
      [shared('100')]: appBlock('UserRoamingConfigStore', '"CloudEnabled" "1"'),
    });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(true);
  });

  it('nimmt „an“ an, wenn das Spiel bekannt ist, aber kein Schalter gesetzt ist (Steam-Standard)', async () => {
    const fs = memoryFs({ [local('100')]: fixture('localconfig.vdf') });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(true);
  });

  it('liest den Schalter auch aus localconfig.vdf', async () => {
    const fs = memoryFs({ [local('100')]: appBlock('UserLocalConfigStore', '"cloudenabled" "0"') });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(false);
  });

  it('global ausgeschaltete Steam Cloud schlägt den App-Schalter', async () => {
    const fs = memoryFs({
      [local('100')]: appBlock('UserLocalConfigStore', '"cloudenabled" "1"', '"CloudEnabled" "0"'),
    });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(false);
  });

  it('gibt null zurück ohne Steam-Ordner, ohne Konten oder wenn das Spiel unbekannt ist', async () => {
    await expect(detectSteamCloudEnabled(STEAM, memoryFs({}))).resolves.toBeNull();
    await expect(
      detectSteamCloudEnabled(STEAM, memoryFs({ [join('userdata', 'anonymous', 'x.vdf')]: '' })),
    ).resolves.toBeNull();
    const other =
      '"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "440" { } } } } } }';
    await expect(
      detectSteamCloudEnabled(STEAM, memoryFs({ [local('100')]: other })),
    ).resolves.toBeNull();
  });

  it('gibt null zurück bei kaputten Dateien statt zu werfen', async () => {
    const fs = memoryFs({
      [local('100')]: '"UserLocalConfigStore" { "Software" {',
      [shared('100')]: '}}}',
    });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBeNull();
  });

  it('nimmt das zuletzt angemeldete Konto, auch wenn ein anderes Konto anders eingestellt ist', async () => {
    const fs = memoryFs({
      [LOGINUSERS]: fixture('loginusers.vdf'),
      [shared('100')]: fixture('sharedconfig-cloud-off.vdf'),
      [shared('101')]: appBlock('UserRoamingConfigStore', '"cloudenabled" "1"'),
    });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(false);
  });

  it('ohne bestimmbares Konto: eines an → true (lieber warnen)', async () => {
    const fs = memoryFs({
      [shared('100')]: fixture('sharedconfig-cloud-off.vdf'),
      [shared('101')]: appBlock('UserRoamingConfigStore', '"cloudenabled" "1"'),
    });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(true);
  });

  it('fällt auf andere Konten zurück, wenn das letzte Konto das Spiel nicht kennt', async () => {
    const fs = memoryFs({
      [LOGINUSERS]: fixture('loginusers.vdf'),
      [join('userdata', '100', 'config', 'other.vdf')]: '',
      [shared('101')]: fixture('sharedconfig-cloud-off.vdf'),
    });
    await expect(detectSteamCloudEnabled(STEAM, fs)).resolves.toBe(false);
  });
});

describe('mostRecentAccountId', () => {
  it('rechnet die SteamID64 des zuletzt angemeldeten Kontos in die Account-ID um', async () => {
    const fs = memoryFs({ [LOGINUSERS]: fixture('loginusers.vdf') });
    await expect(mostRecentAccountId(STEAM, fs)).resolves.toBe('100');
  });

  it('gibt null zurück ohne Datei oder ohne gültige ID', async () => {
    await expect(mostRecentAccountId(STEAM, memoryFs({}))).resolves.toBeNull();
    const bad = '"users" { "abc" { "MostRecent" "1" } }';
    await expect(mostRecentAccountId(STEAM, memoryFs({ [LOGINUSERS]: bad }))).resolves.toBeNull();
  });
});

describe('detectForAccount', () => {
  it('ignoriert Schalter mit unbekanntem Wert und bleibt beim Standard', async () => {
    const fs = memoryFs({
      [shared('100')]: appBlock('UserRoamingConfigStore', '"cloudenabled" "ja"'),
    });
    await expect(detectForAccount(STEAM, '100', fs)).resolves.toBe(true);
  });
});
