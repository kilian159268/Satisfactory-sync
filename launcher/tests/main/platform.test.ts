import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chooseSaveDir,
  detectInstalledGames,
  findEpicGame,
  findEpicGameDir,
  findSaveDirs,
  findSteamGameDir,
  findSteamRoot,
  parseRegQueryValue,
  parseVdf,
  platformOfSaveId,
  readInstalledBuild,
  steamLibrariesFromVdf,
  suggestPlatform,
} from '../../src/main/platform/detect';
import {
  GameProcessWatcher,
  isGameProcess,
  launchUriFor,
  parseTasklistCsv,
  tasklistProbe,
} from '../../src/main/platform/game-process';
import { FakeClock } from './helpers/fake-clock';
import { MemoryFs } from './helpers/memory-fs';

const VDF = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps"
		{
			"228980"		"1"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"apps"
		{
			"526870"		"25000000000"
		}
	}
}`;

describe('Registry & Steam', () => {
  it('liest Werte aus reg query', () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n\r\n';
    expect(parseRegQueryValue(out, 'SteamPath')).toBe('c:/program files (x86)/steam');
    expect(parseRegQueryValue(out, 'Fehlt')).toBeNull();
  });

  it('findSteamRoot probiert die Schlüssel der Reihe nach', async () => {
    const calls: string[] = [];
    const root = await findSteamRoot((_f, args) => {
      calls.push(args[1] ?? '');
      if (calls.length < 2) return Promise.reject(new Error('fehlt'));
      return Promise.resolve('    InstallPath    REG_SZ    C:\\Steam\r\n');
    });
    expect(root).toBe('C:\\Steam');
    expect(calls).toHaveLength(2);
    expect(await findSteamRoot(() => Promise.reject(new Error('x')))).toBeNull();
  });

  it('parst libraryfolders.vdf, Bibliothek mit Satisfactory zuerst', () => {
    expect(parseVdf('"a" { "b" "c" }')).toEqual({ a: { b: 'c' } });
    expect(steamLibrariesFromVdf(VDF)).toEqual([
      'D:\\SteamLibrary',
      'C:\\Program Files (x86)\\Steam',
    ]);
  });

  it('findet den Spielordner über appmanifest/installdir', async () => {
    const fs = new MemoryFs();
    const lib = resolve('/lib');
    fs.put(
      resolve('/steam/steamapps/libraryfolders.vdf'),
      `"libraryfolders" { "1" { "path" "${lib.replace(/\\/g, '\\\\')}" "apps" { "526870" "1" } } }`,
    );
    fs.put(
      join(lib, 'steamapps/appmanifest_526870.acf'),
      '"AppState" { "appid" "526870" "installdir" "Satisfactory" }',
    );
    await fs.mkdir(join(lib, 'steamapps/common/Satisfactory'));
    expect(await findSteamGameDir(fs, resolve('/steam'))).toBe(
      join(lib, 'steamapps', 'common', 'Satisfactory'),
    );
    expect(await findSteamGameDir(new MemoryFs(), resolve('/steam'))).toBeNull();
  });
});

describe('Epic', () => {
  const MAN = () => resolve('/pd/Epic/EpicGamesLauncher/Data/Manifests');
  const mancpn = (appName: string, ns = 'crab', item = 'b915dfe8dcf74770841c82a4162dc954') =>
    JSON.stringify({
      FormatVersion: 0,
      CatalogNamespace: ns,
      CatalogItemId: item,
      AppName: appName,
    });

  it('findet Satisfactory in den Manifesten (ProgramData)', async () => {
    const fs = new MemoryFs();
    fs.put(join(MAN(), 'a.item'), JSON.stringify({ AppName: 'Fortnite', InstallLocation: '/x' }));
    fs.put(join(MAN(), 'b.item'), '{kaputt');
    fs.put(
      join(MAN(), 'c.item'),
      JSON.stringify({
        AppName: 'CrabEA',
        DisplayName: 'Satisfactory',
        InstallLocation: resolve('/epic/Satisfactory'),
      }),
    );
    await fs.mkdir(resolve('/epic/Satisfactory'));
    expect(await findEpicGameDir(fs, resolve('/pd'))).toBe(resolve('/epic/Satisfactory'));
    const games = await detectInstalledGames(fs, () => Promise.reject(new Error('kein Steam')), {
      localAppData: null,
      programData: resolve('/pd'),
    });
    expect(games.steam).toBeNull();
    expect(games.epic).toMatchObject({ gameDir: resolve('/epic/Satisfactory'), appName: 'CrabEA' });
    expect(suggestPlatform(games)).toBe('epic');
    expect(suggestPlatform({ steam: null, epic: null })).toBeNull();
  });

  it('ohne ProgramData-Manifeste: findet das Spiel über .egstore auf den Laufwerken', async () => {
    // Nachbau einer echten Installation (per-Benutzer-Epic-Launcher, 2026-11-26).
    const fs = new MemoryFs();
    const d = resolve('/D');
    fs.put(join(d, 'Satisfactory', '.egstore', '1911C983.mancpn'), mancpn('CrabEA'));
    fs.put(join(d, 'Satisfactory', 'FactoryGameEGS.exe'), 'exe');
    fs.put(join(d, 'SatisfactoryEarlyAccess', '.egstore', '695BB641.mancpn'), mancpn('CrabEA'));
    fs.put(join(d, 'SatisfactoryEarlyAccess', 'FactoryGame.exe'), 'exe');
    fs.put(join(d, 'Andere', '.egstore', 'x.mancpn'), mancpn('Fortnite', 'fn', 'abc'));
    const games = await detectInstalledGames(fs, () => Promise.reject(new Error('kein Steam')), {
      localAppData: null,
      programData: resolve('/pd-leer'),
      driveRoots: [d],
    });
    expect(games.epic).toEqual({
      gameDir: join(d, 'Satisfactory'),
      appName: 'CrabEA',
      namespace: 'crab',
      itemId: 'b915dfe8dcf74770841c82a4162dc954',
    });
    expect(launchUriFor('epic', games.epic)).toBe(
      'com.epicgames.launcher://apps/crab%3Ab915dfe8dcf74770841c82a4162dc954%3ACrabEA?action=launch&silent=true',
    );
  });

  it('sucht auch in „Program Files/Epic Games“, „Games“ und „Spiele“', async () => {
    for (const sub of [['Program Files', 'Epic Games'], ['Games'], ['Spiele']]) {
      const fs = new MemoryFs();
      const d = resolve('/E');
      fs.put(
        join(d, ...sub, 'SatisfactoryExperimental', '.egstore', 'm.mancpn'),
        mancpn('CrabTest'),
      );
      const game = await findEpicGame(fs, null, [d]);
      expect(game?.appName).toBe('CrabTest');
    }
  });

  it('nur Experimental installiert → startet genau diese Version', async () => {
    const fs = new MemoryFs();
    fs.put(
      join(MAN(), 'x.item'),
      JSON.stringify({
        AppName: 'CrabTest',
        DisplayName: 'Satisfactory Experimental',
        InstallLocation: resolve('/epic/SatisfactoryExperimental'),
      }),
    );
    await fs.mkdir(resolve('/epic/SatisfactoryExperimental'));
    const game = await findEpicGame(fs, resolve('/pd'));
    expect(game).toMatchObject({
      gameDir: resolve('/epic/SatisfactoryExperimental'),
      appName: 'CrabTest',
    });
    expect(launchUriFor('epic', game)).toBe(
      'com.epicgames.launcher://apps/CrabTest?action=launch&silent=true',
    );
  });

  it('beide installiert → normale Version (CrabEA) gewinnt', async () => {
    const fs = new MemoryFs();
    fs.put(
      join(MAN(), 'a.item'),
      JSON.stringify({ AppName: 'CrabTest', InstallLocation: resolve('/epic/Exp') }),
    );
    fs.put(
      join(MAN(), 'b.item'),
      JSON.stringify({ AppName: 'CrabEA', InstallLocation: resolve('/epic/Std') }),
    );
    await fs.mkdir(resolve('/epic/Exp'));
    await fs.mkdir(resolve('/epic/Std'));
    expect(await findEpicGame(fs, resolve('/pd'))).toMatchObject({
      gameDir: resolve('/epic/Std'),
      appName: 'CrabEA',
    });
  });

  it('verdächtige Werte werden nicht in den Startbefehl übernommen', async () => {
    const fs = new MemoryFs();
    fs.put(
      join(MAN(), 'a.item'),
      JSON.stringify({ AppName: 'Crab?x=1&y', InstallLocation: resolve('/epic/S') }),
    );
    await fs.mkdir(resolve('/epic/S'));
    expect((await findEpicGame(fs, resolve('/pd')))?.appName).toBe('CrabEA');
    expect(launchUriFor('epic')).toBe(
      'com.epicgames.launcher://apps/CrabEA?action=launch&silent=true',
    );
    expect(launchUriFor('epic', { appName: 'CrabEA', namespace: 'crab', itemId: 'a/b' })).toBe(
      'com.epicgames.launcher://apps/CrabEA?action=launch&silent=true',
    );
  });

  it('liest die .version-Datei auch unter Engine/Binaries/Win64 (Build 463028, Epic)', async () => {
    const fs = new MemoryFs();
    fs.put(
      resolve('/g/Engine/Binaries/Win64/FactoryGameEGS-Win64-Shipping.version'),
      JSON.stringify({ MajorVersion: 5, Changelist: 463028, BuildId: '463028' }),
    );
    expect(await readInstalledBuild(fs, resolve('/g'), 'epic')).toBe(463028);
  });

  it('nichts gefunden → null', async () => {
    expect(await findEpicGame(new MemoryFs(), resolve('/pd'), [resolve('/D')])).toBeNull();
  });
});

describe('Spielversion & Save-Ordner', () => {
  it('liest Changelist aus der .version-Datei', async () => {
    const fs = new MemoryFs();
    fs.put(
      resolve('/g/FactoryGame/Binaries/Win64/FactoryGameEGS-Win64-Shipping.version'),
      JSON.stringify({ Changelist: 416835 }),
    );
    expect(await readInstalledBuild(fs, resolve('/g'), 'epic')).toBe(416835);
    expect(await readInstalledBuild(fs, resolve('/g'), 'steam')).toBeNull();
  });

  it('erkennt Steam- (17 Ziffern) und Epic-IDs (32 Hex), wählt den jüngsten', async () => {
    expect(platformOfSaveId('76561198000000001')).toBe('steam');
    expect(platformOfSaveId('0123456789abcdef0123456789ABCDEF')).toBe('epic');
    expect(platformOfSaveId('common')).toBeNull();
    const fs = new MemoryFs();
    const root = resolve('/lad/FactoryGame/Saved/SaveGames');
    fs.put(join(root, '76561198000000001/a.sav'), 'x', 100);
    fs.put(join(root, '76561198000000002/a.sav'), 'x', 300);
    fs.put(join(root, '0123456789abcdef0123456789abcdef/a.sav'), 'x', 500);
    fs.put(join(root, 'blueprints/x.sbp'), 'x', 900);
    const dirs = await findSaveDirs(fs, resolve('/lad'));
    expect(dirs.map((d) => d.id)).toEqual([
      '0123456789abcdef0123456789abcdef',
      '76561198000000002',
      '76561198000000001',
    ]);
    expect(chooseSaveDir(dirs, 'steam')?.id).toBe('76561198000000002');
    expect(chooseSaveDir(dirs, 'epic')?.platform).toBe('epic');
    expect(chooseSaveDir([], 'epic')).toBeNull();
  });
});

describe('Spielprozess', () => {
  it('Start-URIs', () => {
    expect(launchUriFor('steam')).toBe('steam://rungameid/526870');
    expect(launchUriFor('epic')).toBe(
      'com.epicgames.launcher://apps/CrabEA?action=launch&silent=true',
    );
  });

  it('parst tasklist /FO CSV /NH', async () => {
    const out =
      '"System Idle Process","0","Services","0","8 K"\r\n"FactoryGameSteam-Win64-Shipping.exe","4242","Console","1","9.000.000 K"\r\n';
    expect(parseTasklistCsv(out)).toEqual([
      'System Idle Process',
      'FactoryGameSteam-Win64-Shipping.exe',
    ]);
    expect(isGameProcess('factorygameegs-win64-shipping.exe')).toBe(true);
    expect(isGameProcess('FactoryGame.exe')).toBe(false);
    expect(await tasklistProbe(() => Promise.resolve(out))()).toBe(true);
    expect(await tasklistProbe(() => Promise.resolve('"x.exe","1"'))()).toBe(false);
  });

  it('Wächter: kurzes Fehlen (Steam-Neustart) ist kein Spielende', async () => {
    const clock = new FakeClock();
    let running = false;
    const w = new GameProcessWatcher(() => Promise.resolve(running), clock, 1_000, 3_000);
    const events: boolean[] = [];
    w.onChange((r) => events.push(r));
    expect(await w.start()).toBe(false);
    running = true;
    await clock.advance(1_000);
    expect(events).toEqual([true]);
    running = false;
    await clock.advance(2_000);
    running = true;
    await clock.advance(1_000);
    expect(events).toEqual([true]);
    running = false;
    await clock.advance(5_000);
    expect(events).toEqual([true, false]);
    w.stop();
  });

  it('Wächter: Fehler beim Abfragen ändern nichts', async () => {
    const clock = new FakeClock();
    let fail = false;
    const w = new GameProcessWatcher(
      () => (fail ? Promise.reject(new Error('x')) : Promise.resolve(true)),
      clock,
      1_000,
      1_000,
    );
    expect(await w.start()).toBe(true);
    fail = true;
    await clock.advance(10_000);
    expect(w.isRunning()).toBe(true);
    w.stop();
  });
});
