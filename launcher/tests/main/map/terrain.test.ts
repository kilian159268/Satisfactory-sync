import { describe, expect, it } from 'vitest';
import { MapDataSchema, TERRAIN_NO_DATA } from '../../../src/shared/ipc';
import { buildMapData } from '../../../src/main/map/build-map-data';
import { isTerrainSample } from '../../../src/main/map/building-classes';
import { buildTerrain, encodeHeights } from '../../../src/main/map/terrain';

const decode = (b64: string, n: number): number[] => {
  const buf = Buffer.from(b64, 'base64');
  return Array.from({ length: n }, (_, i) => buf.readInt16LE(i * 2));
};

const BOUNDS = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

/** Gitter aus Punkten mit z = f(x, y). */
function samples(f: (x: number, y: number) => number, step = 100) {
  const out: { x: number; y: number; z: number }[] = [];
  for (let x = 0; x <= 1000; x += step)
    for (let y = 0; y <= 1000; y += step) out.push({ x, y, z: f(x, y) });
  return out;
}

describe('buildTerrain', () => {
  it('ebenes Gelände → überall dieselbe Höhe', () => {
    const t = buildTerrain(
      samples(() => 42),
      BOUNDS,
      { cellSizeM: 100, radiusM: 250 },
    );
    expect(t).toBeDefined();
    expect(t?.cols).toBe(10);
    expect(t?.rows).toBe(10);
    expect(new Set(decode(t?.heights ?? '', 100))).toEqual(new Set([42]));
    expect(t?.minZ).toBe(42);
    expect(t?.maxZ).toBe(42);
  });

  it('Hang von West nach Ost bleibt erhalten', () => {
    const t = buildTerrain(
      samples((x) => x / 10),
      BOUNDS,
      { cellSizeM: 100, radiusM: 250 },
    );
    const h = decode(t?.heights ?? '', 100);
    const row = h.slice(50, 60);
    for (let i = 1; i < row.length; i++)
      expect(row[i] ?? 0).toBeGreaterThanOrEqual(row[i - 1] ?? 0);
    expect((row[9] ?? 0) - (row[0] ?? 0)).toBeGreaterThan(50);
  });

  it('Zellen ohne Punkte im Umkreis bleiben unbekannt', () => {
    const pts = samples(() => 10).filter((p) => p.x <= 300);
    const t = buildTerrain(pts, BOUNDS, { cellSizeM: 100, radiusM: 150, minSamples: 5 });
    const h = decode(t?.heights ?? '', 100);
    expect(h[0]).toBe(10);
    expect(h[9]).toBe(TERRAIN_NO_DATA);
  });

  it('zu wenige Punkte → kein Relief', () => {
    expect(buildTerrain([{ x: 1, y: 1, z: 1 }], BOUNDS)).toBeUndefined();
  });

  it('Unsinn (NaN, riesige Höhen) wird ignoriert', () => {
    const pts = [
      ...samples(() => 5),
      { x: 500, y: 500, z: Number.NaN },
      { x: 500, y: 500, z: 1e9 },
    ];
    const t = buildTerrain(pts, BOUNDS, { cellSizeM: 100, radiusM: 250 });
    expect(t?.maxZ).toBe(5);
  });

  it('Rasterbreite bleibt begrenzt', () => {
    const t = buildTerrain(
      samples(() => 1),
      { minX: 0, minY: 0, maxX: 100_000, maxY: 1000 },
      { cellSizeM: 10, radiusM: 50_000 },
    );
    expect(t?.cols).toBeLessThanOrEqual(512);
  });

  it('Kodierung: Int16 little-endian, auch negativ', () => {
    expect(decode(encodeHeights(Int16Array.from([-104, 413, TERRAIN_NO_DATA])), 3)).toEqual([
      -104,
      413,
      TERRAIN_NO_DATA,
    ]);
  });
});

describe('Geländepunkte im Spielstand', () => {
  it('Rohstoffe, Absturzstellen, Tiere zählen – Gebäude und Spieler nicht', () => {
    expect(isTerrainSample('/Game/FactoryGame/Resource/BP_ResourceNode.BP_ResourceNode_C')).toBe(
      true,
    );
    expect(isTerrainSample('/Game/FactoryGame/World/Benefit/DropPod/BP_DropPod.BP_DropPod_C')).toBe(
      true,
    );
    expect(
      isTerrainSample(
        '/Game/FactoryGame/Character/Creature/Wildlife/SpaceRabbit/Char_SpaceRabbit.Char_SpaceRabbit_C',
      ),
    ).toBe(true);
    expect(
      isTerrainSample(
        '/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C',
      ),
    ).toBe(false);
    expect(isTerrainSample('/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C')).toBe(
      false,
    );
  });

  it('buildMapData hängt das Relief an und zeigt dann die ganze Welt', () => {
    const objects = [];
    for (let x = -3000; x <= 4000; x += 250) {
      for (let y = -3500; y <= 3500; y += 250) {
        objects.push({
          typePath: '/Game/FactoryGame/Resource/BP_ResourceNode.BP_ResourceNode_C',
          x: x * 100,
          y: y * 100,
          z: ((x + y) / 50) * 100,
        });
      }
    }
    const data = buildMapData(objects, []);
    expect(data.terrain).toBeDefined();
    expect(MapDataSchema.safeParse(data).success).toBe(true);
    expect(data.bounds.minX).toBeLessThanOrEqual(-3247);
    expect(data.bounds.maxY).toBeGreaterThanOrEqual(3750);
    expect(JSON.stringify(data).length).toBeLessThan(200_000);
  });

  it('ohne Geländepunkte bleibt die Karte wie bisher (kein terrain-Feld)', () => {
    const data = buildMapData(
      [
        {
          typePath:
            '/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C',
          x: 0,
          y: 0,
          z: 0,
        },
      ],
      [],
    );
    expect(data.terrain).toBeUndefined();
    expect(MapDataSchema.safeParse(data).success).toBe(true);
  });

  it('Schema lehnt ein zu kurzes Höhenraster ab', () => {
    const data = buildMapData([], []);
    const bad = {
      ...data,
      terrain: {
        minX: 0,
        minY: 0,
        cellSize: 50,
        cols: 10,
        rows: 10,
        minZ: 0,
        maxZ: 1,
        waterZ: -20,
        heights: 'AAAA',
      },
    };
    expect(MapDataSchema.safeParse(bad).success).toBe(false);
  });
});
