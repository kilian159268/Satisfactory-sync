/**
 * Geschätztes Höhenrelief aus bodennahen Objekten des Spielstands (Plan 6.6).
 * Inverse-Distanz-Gewichtung (IDW) auf ein festes Raster über die ganze Welt; Zellen ohne
 * Punkte im Umkreis bleiben „unbekannt“, statt erfunden zu werden. Rein, ohne Ein-/Ausgabe.
 */
import { TERRAIN_NO_DATA, type Terrain } from '@shared/ipc';
import { TERRAIN_WATER_LEVEL_M, WORLD_BOUNDS_M } from './building-classes';

/** Geländepunkt in Metern. */
export interface TerrainSample {
  x: number;
  y: number;
  z: number;
}

export interface TerrainOptions {
  /** Kantenlänge einer Zelle in Metern (Standard 50). */
  cellSizeM?: number;
  /** Nur Punkte in diesem Umkreis zählen (Standard 600 m). */
  radiusM?: number;
  /** Mindestzahl Punkte, sonst kein Relief (Standard 20). */
  minSamples?: number;
}

const DEFAULTS = { cellSizeM: 50, radiusM: 600, minSamples: 20 };
const POWER = 2;
const MAX_CELLS_PER_AXIS = 512;
const Z_LIMIT = 30_000;

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function buildTerrain(
  samples: readonly TerrainSample[],
  bounds: Bounds = WORLD_BOUNDS_M,
  options: TerrainOptions = {},
): Terrain | undefined {
  const opts = { ...DEFAULTS, ...options };
  const points = samples.filter(
    (s) =>
      Number.isFinite(s.x) &&
      Number.isFinite(s.y) &&
      Number.isFinite(s.z) &&
      Math.abs(s.z) < Z_LIMIT &&
      s.x >= bounds.minX - opts.radiusM &&
      s.x <= bounds.maxX + opts.radiusM &&
      s.y >= bounds.minY - opts.radiusM &&
      s.y <= bounds.maxY + opts.radiusM,
  );
  if (points.length < opts.minSamples) return undefined;

  let cell = opts.cellSizeM;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  while (span / cell > MAX_CELLS_PER_AXIS) cell *= 2;
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cell));

  // Räumliches Raster der Punkte (Kantenlänge = Radius) für schnelle Nachbarsuche.
  const r = opts.radiusM;
  const buckets = new Map<string, TerrainSample[]>();
  for (const p of points) {
    const key = `${Math.floor(p.x / r)},${Math.floor(p.y / r)}`;
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }

  const raw = new Float64Array(cols * rows).fill(Number.NaN);
  for (let row = 0; row < rows; row++) {
    const cy = bounds.minY + (row + 0.5) * cell;
    for (let col = 0; col < cols; col++) {
      const cx = bounds.minX + (col + 0.5) * cell;
      const bx = Math.floor(cx / r);
      const by = Math.floor(cy / r);
      let wSum = 0;
      let zSum = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const p of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
            const d = Math.hypot(p.x - cx, p.y - cy);
            if (d > r) continue;
            const w = 1 / Math.max(1, d) ** POWER;
            wSum += w;
            zSum += w * p.z;
          }
        }
      }
      if (wSum > 0) raw[row * cols + col] = zSum / wSum;
    }
  }

  // Eine Glättung (3×3, nur bekannte Zellen) gegen „Zielscheiben“ um einzelne Punkte.
  const heights = new Int16Array(cols * rows).fill(TERRAIN_NO_DATA);
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (Number.isNaN(raw[row * cols + col])) continue;
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const rr = row + dy;
          const cc = col + dx;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const v = raw[rr * cols + cc] ?? Number.NaN;
          if (Number.isNaN(v)) continue;
          sum += v;
          n++;
        }
      }
      const z = Math.round(sum / n);
      heights[row * cols + col] = z;
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  if (!Number.isFinite(minZ)) return undefined;

  return {
    minX: bounds.minX,
    minY: bounds.minY,
    cellSize: cell,
    cols,
    rows,
    minZ,
    maxZ,
    waterZ: TERRAIN_WATER_LEVEL_M,
    heights: encodeHeights(heights),
  };
}

export function encodeHeights(heights: Int16Array): string {
  const bytes = new Uint8Array(heights.length * 2);
  const view = new DataView(bytes.buffer);
  heights.forEach((h, i) => {
    view.setInt16(i * 2, h, true);
  });
  return Buffer.from(bytes).toString('base64');
}
