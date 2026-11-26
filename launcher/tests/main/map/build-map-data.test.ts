import { describe, expect, it } from 'vitest';
import { buildMapData, type MapSourceObject } from '../../../src/main/map/build-map-data';
import {
  WORLD_BOUNDS_M,
  isMapBuilding,
  readableTypeName,
} from '../../../src/main/map/building-classes';
import { MapDataSchema } from '../../../src/shared/ipc';

const F = '/Game/FactoryGame/Buildable/Factory';
const CONSTRUCTOR = `${F}/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C`;
const SMELTER = `${F}/SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C`;
const MINER = `${F}/MinerMK1/Build_MinerMk1.Build_MinerMk1_C`;
const COAL = `${F}/GeneratorCoal/Build_GeneratorCoal.Build_GeneratorCoal_C`;
const BELT = `${F}/ConveyorBeltMk1/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C`;
const SPLITTER = `${F}/CA_Splitter/Build_ConveyorAttachmentSplitter.Build_ConveyorAttachmentSplitter_C`;
const PIPE = `${F}/Pipeline/Build_Pipeline.Build_Pipeline_C`;
const POLE = `${F}/PowerPoleMk1/Build_PowerPoleMk1.Build_PowerPoleMk1_C`;
const CABLE = `${F}/PowerLine/Build_PowerLine.Build_PowerLine_C`;
const FOUNDATION =
  '/Game/FactoryGame/Buildable/Building/Foundation/Build_Foundation_8x4_01.Build_Foundation_8x4_01_C';
const WALL = '/Game/FactoryGame/Buildable/Building/Wall/Build_Wall_8x4_01.Build_Wall_8x4_01_C';
const STATION = `${F}/Train/Station/Build_TrainStation.Build_TrainStation_C`;
const TRACK = `${F}/Train/Track/Build_RailroadTrack.Build_RailroadTrack_C`;
const FUTURE = `${F}/QuantumThing/Build_QuantumThingMk2.Build_QuantumThingMk2_C`;

/** `n` Objekte rund um (xM, yM) Meter, Position in cm. */
function around(typePath: string, xM: number, yM: number, n: number): MapSourceObject[] {
  return Array.from({ length: n }, (_, i) => ({
    typePath,
    x: (xM + (i % 5)) * 100,
    y: (yM + Math.floor(i / 5)) * 100,
  }));
}

describe('buildMapData', () => {
  it('leere Welt: keine Cluster, Weltgrenzen als bounds, schema-gültig', () => {
    const map = buildMapData([], []);
    expect(map.clusters).toEqual([]);
    expect(map.stations).toEqual([]);
    expect(map.players).toEqual([]);
    expect(map.bounds).toEqual(WORLD_BOUNDS_M);
    expect(MapDataSchema.safeParse(map).success).toBe(true);
  });

  it('fasst nahe Gebäude zusammen und trennt entfernte Fabriken', () => {
    const map = buildMapData(
      [
        ...around(CONSTRUCTOR, 10, 10, 6),
        ...around(SMELTER, 20, 20, 4),
        ...around(MINER, 3000, -2000, 3),
      ],
      [],
    );
    expect(map.clusters).toHaveLength(2);
    const [big, small] = map.clusters;
    expect(big?.count).toBe(10);
    expect(small?.count).toBe(3);
    expect(big?.topTypes).toEqual(['Konstruktor', 'Schmelzofen']);
    expect(small?.topTypes).toEqual(['Miner Mk.1']);
    // Mittelpunkt in Metern (Schwerpunkt der Gebäude)
    expect(small?.x).toBeCloseTo(3001, 0);
    expect(small?.y).toBeCloseTo(-2000, 0);
  });

  it('führt benachbarte Zellen (über eine Zellgrenze hinweg) zusammen', () => {
    // 199 m und 201 m liegen in verschiedenen 200-m-Zellen, aber direkt nebeneinander.
    const map = buildMapData([...around(COAL, 195, 0, 2), ...around(COAL, 201, 0, 2)], []);
    expect(map.clusters).toHaveLength(1);
    expect(map.clusters[0]?.count).toBe(4);
  });

  it('lässt eine lange bebaute Strecke nicht zu einem einzigen Cluster verschmelzen', () => {
    const line = Array.from({ length: 20 }, (_, i) =>
      around(CONSTRUCTOR, i * 200 + 50, 50, 1),
    ).flat();
    const map = buildMapData(line, []);
    expect(map.clusters.length).toBeGreaterThan(3);
    expect(map.clusters.reduce((sum, c) => sum + c.count, 0)).toBe(20);
  });

  it('schließt Bänder, Rohre, Kabel, Masten, Fundamente, Wände und Schienen aus', () => {
    const noise = [BELT, SPLITTER, PIPE, POLE, CABLE, FOUNDATION, WALL, TRACK].flatMap((t) =>
      around(t, 0, 0, 10),
    );
    const map = buildMapData([...noise, ...around(CONSTRUCTOR, 0, 0, 1)], []);
    expect(map.clusters).toHaveLength(1);
    expect(map.clusters[0]?.count).toBe(1);
    expect(map.clusters[0]?.topTypes).toEqual(['Konstruktor']);
  });

  it('liefert höchstens 3 Top-Typen, nach Häufigkeit sortiert', () => {
    const map = buildMapData(
      [
        ...around(MINER, 0, 0, 1),
        ...around(CONSTRUCTOR, 0, 0, 5),
        ...around(SMELTER, 0, 0, 3),
        ...around(COAL, 0, 0, 2),
      ],
      [],
    );
    expect(map.clusters[0]?.topTypes).toEqual(['Konstruktor', 'Schmelzofen', 'Kohlekraftwerk']);
  });

  it('unbekannte Gebäude bekommen den aufbereiteten Klassennamen', () => {
    const map = buildMapData(around(FUTURE, 0, 0, 1), []);
    expect(map.clusters[0]?.topTypes).toEqual(['Quantum Thing Mk.2']);
  });

  it('Bahnhöfe mit Namen oder Ersatznamen, nicht in Clustern', () => {
    const map = buildMapData(
      [
        { typePath: STATION, x: 100_000, y: 50_000, name: '  Eisenwerk  ' },
        { typePath: STATION, x: -100_000, y: 0 },
      ],
      [],
    );
    expect(map.clusters).toEqual([]);
    expect(map.stations).toEqual([
      { name: 'Eisenwerk', x: 1000, y: 500 },
      { name: 'Bahnhof 2', x: -1000, y: 0 },
    ]);
  });

  it('Spieler mit Namen oder „Spieler N“, Koordinaten in Metern', () => {
    const map = buildMapData(
      [],
      [
        { name: 'Kai', x: 12_345, y: -6_789 },
        { x: 0, y: 0 },
        { name: '   ', x: 100, y: 100 },
      ],
    );
    expect(map.players).toEqual([
      { name: 'Kai', x: 123.5, y: -67.9 },
      { name: 'Spieler 2', x: 0, y: 0 },
      { name: 'Spieler 3', x: 1, y: 1 },
    ]);
  });

  it('kürzt lange Namen auf die Schema-Grenze', () => {
    const map = buildMapData([], [{ name: 'x'.repeat(200), x: 0, y: 0 }]);
    expect(map.players[0]?.name).toHaveLength(64);
    expect(MapDataSchema.safeParse(map).success).toBe(true);
  });

  it('bounds umfassen Gebäude, Bahnhöfe und Spieler mit 100 m Rand', () => {
    const map = buildMapData(
      [...around(CONSTRUCTOR, 0, 0, 1), { typePath: STATION, x: 50_000, y: 0 }],
      [{ x: 0, y: -30_000 }],
    );
    expect(map.bounds).toEqual({ minX: -100, minY: -400, maxX: 600, maxY: 100 });
  });

  it('ignoriert Objekte mit ungültiger Position', () => {
    const map = buildMapData(
      [
        { typePath: CONSTRUCTOR, x: Number.NaN, y: 0 },
        { typePath: CONSTRUCTOR, x: Infinity, y: 0 },
      ],
      [{ x: 0, y: Number.NaN }],
    );
    expect(map.clusters).toEqual([]);
    expect(map.players).toEqual([]);
    expect(MapDataSchema.safeParse(map).success).toBe(true);
  });

  it('bleibt bei einer riesigen, verstreuten Welt unter 200 KB und begrenzt die Cluster', () => {
    const objects: MapSourceObject[] = [];
    // 100 000 Gebäude auf einem 7,5 × 7,5 km großen Feld, ein Gebäude alle ~25 m.
    for (let i = 0; i < 100_000; i++) {
      objects.push({
        typePath: i % 2 ? CONSTRUCTOR : FUTURE,
        x: ((i * 7919) % 750_000) - 375_000,
        y: ((i * 104_729) % 750_000) - 375_000,
      });
    }
    const stations = Array.from({ length: 1000 }, (_, i) => ({
      typePath: STATION,
      x: i * 100,
      y: 0,
      name: `Bahnhof mit sehr langem Namen Nummer ${i}`,
    }));
    const players = Array.from({ length: 500 }, (_, i) => ({ name: `Spieler-${i}`, x: i, y: i }));
    const map = buildMapData([...objects, ...stations], players);
    const bytes = Buffer.byteLength(JSON.stringify(map), 'utf8');
    expect(bytes).toBeLessThan(200 * 1024);
    expect(map.clusters.length).toBeLessThanOrEqual(400);
    expect(map.stations.length).toBeLessThanOrEqual(300);
    expect(map.players.length).toBeLessThanOrEqual(64);
    expect(MapDataSchema.safeParse(map).success).toBe(true);
  });

  it('hält ein vorgegebenes Cluster-Limit ein', () => {
    const scattered = Array.from({ length: 50 }, (_, i) => around(SMELTER, i * 5000, 0, 1)).flat();
    const map = buildMapData(scattered, [], { maxClusters: 10 });
    expect(map.clusters.length).toBeLessThanOrEqual(10);
    expect(map.clusters.length).toBeGreaterThan(0);
  });

  it('ist deterministisch', () => {
    const objects = [...around(CONSTRUCTOR, 0, 0, 7), ...around(MINER, 900, 900, 4)];
    expect(buildMapData(objects, [])).toEqual(buildMapData([...objects].reverse(), []));
  });
});

describe('building-classes', () => {
  it('erkennt Fabrikgebäude und schließt Logistik/Bauteile aus', () => {
    expect(isMapBuilding(CONSTRUCTOR)).toBe(true);
    expect(isMapBuilding(COAL)).toBe(true);
    expect(isMapBuilding(MINER)).toBe(true);
    for (const t of [BELT, SPLITTER, PIPE, POLE, CABLE, FOUNDATION, WALL, STATION, TRACK]) {
      expect(isMapBuilding(t)).toBe(false);
    }
    expect(isMapBuilding('/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C')).toBe(
      false,
    );
  });

  it('bereitet Klassennamen lesbar auf', () => {
    expect(readableTypeName(`${F}/X/Build_FooBarMk3.Build_FooBarMk3_C`)).toBe('Foo Bar Mk.3');
    expect(readableTypeName(`${F}/X/Build_HUBThing.Build_HUBThing_C`)).toBe('HUB Thing');
    expect(readableTypeName(SMELTER)).toBe('Schmelzofen');
  });
});
