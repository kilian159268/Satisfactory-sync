import { describe, expect, it } from 'vitest';
import { TERRAIN_NO_DATA, type Terrain } from '../../src/shared/ipc';
import { decodeHeights, renderTerrainPixels } from '../../src/renderer/lib/terrain-image';

function terrainOf(heights: number[], cols: number, rows: number): Terrain {
  const bytes = new Uint8Array(heights.length * 2);
  const view = new DataView(bytes.buffer);
  heights.forEach((h, i) => {
    view.setInt16(i * 2, h, true);
  });
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const known = heights.filter((h) => h !== TERRAIN_NO_DATA);
  return {
    minX: 0,
    minY: 0,
    cellSize: 50,
    cols,
    rows,
    minZ: Math.min(...known),
    maxZ: Math.max(...known),
    waterZ: -20,
    heights: btoa(bin),
  };
}

const px = (data: Uint8ClampedArray, i: number) => Array.from(data.slice(i * 4, i * 4 + 4));

describe('Geländebild', () => {
  it('dekodiert negative und unbekannte Höhen', () => {
    const t = terrainOf([-104, 0, 413, TERRAIN_NO_DATA], 2, 2);
    expect(Array.from(decodeHeights(t))).toEqual([-104, 0, 413, TERRAIN_NO_DATA]);
  });

  it('Farbig: Wasser blau, Gipfel hell, unbekannt durchsichtig', () => {
    const t = terrainOf([-100, 0, 400, TERRAIN_NO_DATA], 4, 1);
    const { data, width, height } = renderTerrainPixels(t, 'farbig');
    expect([width, height]).toEqual([4, 1]);
    const [wr, wg, wb, wa] = px(data, 0);
    expect(wb).toBeGreaterThan(wr ?? 0);
    expect(wb).toBeGreaterThan(wg ?? 0);
    expect(wa).toBe(255);
    const peak = px(data, 2);
    const low = px(data, 1);
    expect((peak[0] ?? 0) + (peak[1] ?? 0) + (peak[2] ?? 0)).toBeGreaterThan(
      (low[0] ?? 0) + (low[1] ?? 0) + (low[2] ?? 0),
    );
    expect(px(data, 3)[3]).toBe(0);
  });

  it('Gedämpft bleibt dunkel und grau (passend zum Launcher)', () => {
    const t = terrainOf([0, 200, 400, 300], 4, 1);
    const { data } = renderTerrainPixels(t, 'gedaempft');
    for (let i = 0; i < 4; i++) {
      const [r, g, b] = px(data, i);
      expect(Math.max(r ?? 0, g ?? 0, b ?? 0)).toBeLessThan(110);
      expect(Math.abs((r ?? 0) - (g ?? 0))).toBeLessThan(12);
    }
  });

  it('Schattierung: Nordwesthang heller als Südosthang', () => {
    // Pyramide: Mitte hoch.
    const h = [0, 0, 0, 0, 0, 200, 200, 0, 0, 200, 200, 0, 0, 0, 0, 0];
    const { data } = renderTerrainPixels(terrainOf(h, 4, 4), 'farbig');
    const nw = px(data, 5);
    const se = px(data, 10);
    expect((nw[0] ?? 0) + (nw[1] ?? 0)).toBeGreaterThan((se[0] ?? 0) + (se[1] ?? 0));
  });
});
