import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapDataFromSaveBytes } from '../../../src/main/map/parse-save';
import { MAX_PARSER_ARRAY_LENGTH, withParserGuards } from '../../../src/main/map/parser-guards';
import { MapDataSchema } from '../../../src/shared/ipc';
import { buildSyntheticSave } from './synthetic-save';

const CONSTRUCTOR =
  '/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C';
const BELT =
  '/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk1/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C';
const STATION =
  '/Game/FactoryGame/Buildable/Factory/Train/Station/Build_TrainStation.Build_TrainStation_C';
const PLAYER = '/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C';

// Der Parser schreibt bei kaputten Daten viel auf die Konsole.
beforeEach(() => {
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('mapDataFromSaveBytes', () => {
  it('liest einen echten (synthetischen) Spielstand bis zur Karte', () => {
    const bytes = buildSyntheticSave([
      { typePath: CONSTRUCTOR, name: 'C1', x: 10_000, y: 20_000 },
      { typePath: CONSTRUCTOR, name: 'C2', x: 12_000, y: 20_000 },
      { typePath: BELT, name: 'B1', x: 11_000, y: 20_000 },
      { typePath: STATION, name: 'S1', x: -50_000, y: 0 },
      { typePath: PLAYER, name: 'P1', x: 0, y: 30_000 },
    ]);
    const map = mapDataFromSaveBytes('Test', bytes);
    expect(MapDataSchema.safeParse(map).success).toBe(true);
    expect(map.clusters).toEqual([
      { id: 'c0_1', x: 110, y: 200, count: 2, topTypes: ['Konstruktor'] },
    ]);
    expect(map.stations).toEqual([{ name: 'Bahnhof 1', x: -500, y: 0 }]);
    expect(map.players).toEqual([{ name: 'Spieler 1', x: 0, y: 300 }]);
  });

  it('lehnt eine leere Datei ab', () => {
    expect(() => mapDataFromSaveBytes('Leer', new Uint8Array())).toThrow(/leer/);
  });

  it('lehnt Müll-Daten mit klarer Meldung ab, statt den Prozess abstürzen zu lassen', () => {
    // Diese Bytes ließen den Parser ohne Schutz `new Array(~2^31)` anlegen → V8-Abbruch.
    const garbage = new Uint8Array(4096);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 31 + 7) % 256;
    expect(() => mapDataFromSaveBytes('Kaputt', garbage)).toThrow(
      /^Spielstand konnte nicht gelesen werden: /,
    );
    expect(() => mapDataFromSaveBytes('Text', Buffer.from('kein echter Spielstand'))).toThrow(
      /^Spielstand konnte nicht gelesen werden: /,
    );
  });

  it('übersteht beschädigte Spielstand-Inhalte (Fuzzing, deterministisch)', () => {
    const objects = Array.from({ length: 20 }, (_, i) => ({
      typePath: CONSTRUCTOR,
      name: `C${i}`,
      x: i * 100,
      y: 0,
    }));
    let seed = 12345;
    const next = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0);
    for (let round = 0; round < 300; round++) {
      const bytes = buildSyntheticSave(objects, (body) => {
        for (let k = 0; k < 1 + (next() % 6); k++) {
          const pos = 8 + (next() % (body.length - 11));
          body[pos] = next() & 0xff;
          if (round % 4 === 0) body.set([0xff, 0xff, 0x8f], pos + 1);
        }
      });
      try {
        expect(MapDataSchema.safeParse(mapDataFromSaveBytes('Fuzz', bytes)).success).toBe(true);
      } catch (err) {
        expect((err as Error).message).toMatch(/^Spielstand konnte nicht gelesen werden: /);
      }
    }
  });
});

describe('withParserGuards', () => {
  it('lässt absurde Array-Längen scheitern und stellt danach alles wieder her', () => {
    const OriginalArray = Array;
    withParserGuards(() => {
      expect(() => {
        return new Array(MAX_PARSER_ARRAY_LENGTH + 1).length;
      }).toThrow(RangeError);
      // normale Nutzung bleibt möglich
      expect(new Array(3).fill(0)).toEqual([0, 0, 0]);
      expect(Array.isArray([1])).toBe(true);
      expect([1] instanceof Array).toBe(true);
      expect(Array.from({ length: 2 }, (_, i) => i)).toEqual([0, 1]);
    });
    expect(globalThis.Array).toBe(OriginalArray);
  });

  it('stellt auch nach einem Fehler wieder her', () => {
    const OriginalArray = Array;
    expect(() =>
      withParserGuards(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(globalThis.Array).toBe(OriginalArray);
  });
});
