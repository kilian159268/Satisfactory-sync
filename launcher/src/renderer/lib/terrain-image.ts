/**
 * Höhenraster (Plan 6.6) → RGBA-Pixel für die Geländeebenen der Karte. Rein und ohne DOM,
 * damit testbar; das Zeichnen auf ein Canvas macht `terrainDataUrl`.
 */
import { TERRAIN_NO_DATA, type Terrain } from '../../shared/ipc';

export type MapLayer = 'farbig' | 'gedaempft' | 'schematisch';
export const MAP_LAYERS: readonly { id: MapLayer; label: string }[] = [
  { id: 'farbig', label: 'Farbig' },
  { id: 'gedaempft', label: 'Gedämpft' },
  { id: 'schematisch', label: 'Schematisch' },
];

type Rgb = readonly [number, number, number];

/** Höhenfarben von Tiefland bis Gipfel (Anteil 0–1 zwischen Wasserspiegel und höchster Stelle). */
const LAND_STOPS: readonly (readonly [number, Rgb])[] = [
  [0, [62, 110, 58]],
  [0.2, [88, 132, 62]],
  [0.4, [128, 136, 72]],
  [0.6, [138, 112, 78]],
  [0.8, [124, 118, 112]],
  [1, [214, 214, 208]],
];
const WATER_SHALLOW: Rgb = [46, 104, 140];
const WATER_DEEP: Rgb = [24, 58, 88];

/** Gedämpft: Grautöne des Launchers (#1C1D20 … #4A4B52), Wasser leicht bläulich. */
const MUTED_LOW: Rgb = [30, 31, 35];
const MUTED_HIGH: Rgb = [78, 79, 86];
const MUTED_WATER: Rgb = [22, 30, 40];

/** Überhöhung für die Schattierung, damit flaches Gelände nicht verschwindet. */
const EXAGGERATION = 3;

export function decodeHeights(terrain: Terrain): Int16Array {
  const binary = atob(terrain.heights);
  const count = terrain.cols * terrain.rows;
  const out = new Int16Array(count).fill(TERRAIN_NO_DATA);
  for (let i = 0; i < count && i * 2 + 1 < binary.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    const v = lo | (hi << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function landColor(t: number): Rgb {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < LAND_STOPS.length; i++) {
    const [p1, c1] = LAND_STOPS[i] ?? [1, LAND_STOPS[0]?.[1] ?? [0, 0, 0]];
    const [p0, c0] = LAND_STOPS[i - 1] ?? [0, c1];
    if (x <= p1) return lerp(c0, c1, (x - p0) / (p1 - p0 || 1));
  }
  return LAND_STOPS[LAND_STOPS.length - 1]?.[1] ?? [255, 255, 255];
}

export interface TerrainPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Pixel je Rasterzelle (1:1). Unbekannte Zellen bleiben durchsichtig. */
export function renderTerrainPixels(
  terrain: Terrain,
  layer: Exclude<MapLayer, 'schematisch'>,
): TerrainPixels {
  const { cols, rows, cellSize, waterZ, maxZ, minZ } = terrain;
  const h = decodeHeights(terrain);
  const data = new Uint8ClampedArray(cols * rows * 4);
  const at = (c: number, r: number, fallback: number): number => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return fallback;
    const v = h[r * cols + c] ?? TERRAIN_NO_DATA;
    return v === TERRAIN_NO_DATA ? fallback : v;
  };
  const landTop = Math.max(waterZ + 1, maxZ);
  const deepest = Math.min(waterZ - 1, minZ);
  // Licht von Nordwest, 45° hoch.
  const lx = -Math.SQRT1_2 * Math.SQRT1_2;
  const ly = -Math.SQRT1_2 * Math.SQRT1_2;
  const lz = Math.SQRT1_2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = h[r * cols + c] ?? TERRAIN_NO_DATA;
      const i = (r * cols + c) * 4;
      if (z === TERRAIN_NO_DATA) continue; // durchsichtig
      const dzdx = ((at(c + 1, r, z) - at(c - 1, r, z)) * EXAGGERATION) / (2 * cellSize);
      const dzdy = ((at(c, r + 1, z) - at(c, r - 1, z)) * EXAGGERATION) / (2 * cellSize);
      const len = Math.hypot(dzdx, dzdy, 1);
      const lambert = (-dzdx * lx + -dzdy * ly + lz) / len;
      const water = z < waterZ;
      let rgb: Rgb;
      let shade: number;
      if (layer === 'farbig') {
        rgb = water
          ? lerp(WATER_SHALLOW, WATER_DEEP, (waterZ - z) / (waterZ - deepest))
          : landColor((z - waterZ) / (landTop - waterZ));
        shade = water ? 1 : 0.55 + 0.6 * lambert;
      } else {
        rgb = water ? MUTED_WATER : lerp(MUTED_LOW, MUTED_HIGH, (z - waterZ) / (landTop - waterZ));
        shade = water ? 1 : 0.75 + 0.35 * lambert;
      }
      data[i] = rgb[0] * shade;
      data[i + 1] = rgb[1] * shade;
      data[i + 2] = rgb[2] * shade;
      data[i + 3] = 255;
    }
  }
  return { width: cols, height: rows, data };
}

/** Zeichnet das Relief als PNG-Data-URL (null, wenn kein Canvas verfügbar ist, z. B. in Tests). */
export function terrainDataUrl(
  terrain: Terrain,
  layer: Exclude<MapLayer, 'schematisch'>,
): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const pixels = renderTerrainPixels(terrain, layer);
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    const image = ctx.createImageData(pixels.width, pixels.height);
    image.data.set(pixels.data);
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

const LAYER_KEY = 'v3in-sync.mapLayer';

export function loadMapLayer(): MapLayer {
  try {
    const v = window.localStorage.getItem(LAYER_KEY);
    if (v === 'farbig' || v === 'gedaempft' || v === 'schematisch') return v;
  } catch {
    // kein Speicher verfügbar
  }
  return 'farbig';
}

export function saveMapLayer(layer: MapLayer): void {
  try {
    window.localStorage.setItem(LAYER_KEY, layer);
  } catch {
    // egal – dann eben nur für diese Sitzung
  }
}
