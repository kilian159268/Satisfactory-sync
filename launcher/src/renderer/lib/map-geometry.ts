/**
 * Geometrie der selbst gezeichneten Karte: Weltkoordinaten (Unreal-Einheiten aus map.json)
 * → SVG-Benutzereinheiten, Zoom und viewBox. Rein und ohne React.
 */
import type { MapData } from '../../shared/ipc';

/** Breite der Karte in SVG-Einheiten; die Höhe folgt aus dem Seitenverhältnis der Welt. */
export const MAP_WIDTH = 1000;
/** Rand um die Welt in SVG-Einheiten. */
export const MAP_PAD = 48;
/** Abstand der Gitterlinien in SVG-Einheiten. */
export const GRID_STEP = 80;
export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;

export interface Point {
  x: number;
  y: number;
}

export interface MapFrame {
  width: number;
  height: number;
  project(x: number, y: number): Point;
}

export function createFrame(bounds: MapData['bounds']): MapFrame {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = MAP_WIDTH / spanX;
  return {
    width: MAP_WIDTH,
    height: spanY * scale,
    project: (x, y) => ({ x: (x - bounds.minX) * scale, y: (y - bounds.minY) * scale }),
  };
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}

/** viewBox für Zoomstufe und Mittelpunkt; bleibt innerhalb der Karte samt Rand. */
export function computeViewBox(frame: MapFrame, zoom: number, center: Point | null): ViewBox {
  const fullW = frame.width + 2 * MAP_PAD;
  const fullH = frame.height + 2 * MAP_PAD;
  const width = fullW / zoom;
  const height = fullH / zoom;
  const c = center ?? { x: frame.width / 2, y: frame.height / 2 };
  const cx = clamp(c.x, width / 2 - MAP_PAD, frame.width + MAP_PAD - width / 2);
  const cy = clamp(c.y, height / 2 - MAP_PAD, frame.height + MAP_PAD - height / 2);
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

export function viewBoxString(box: ViewBox): string {
  return [box.x, box.y, box.width, box.height].map((n) => Number(n.toFixed(2))).join(' ');
}

export interface GridLine {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Gitter, das auch die Ränder links/rechts bzw. oben/unten (Letterbox) abdeckt. */
export function gridLines(frame: MapFrame): GridLine[] {
  const lines: GridLine[] = [];
  const extent = Math.max(frame.width, frame.height) * 2;
  const minX = -extent;
  const maxX = frame.width + extent;
  const minY = -extent;
  const maxY = frame.height + extent;
  for (let x = Math.ceil(minX / GRID_STEP) * GRID_STEP; x <= maxX; x += GRID_STEP) {
    lines.push({ key: `v${x}`, x1: x, y1: minY, x2: x, y2: maxY });
  }
  for (let y = Math.ceil(minY / GRID_STEP) * GRID_STEP; y <= maxY; y += GRID_STEP) {
    lines.push({ key: `h${y}`, x1: minX, y1: y, x2: maxX, y2: y });
  }
  return lines;
}

/** Kantenlänge eines Cluster-Quadrats nach Gebäudeanzahl: 12 … 24 Einheiten, gerade. */
export function clusterSize(count: number): number {
  const size = 12 + Math.round(Math.log2(Math.max(1, count)) * 1.25);
  const even = size - (size % 2);
  return Math.min(24, Math.max(12, even));
}

export function nextZoom(current: number, direction: 1 | -1): number {
  const index = ZOOM_LEVELS.findIndex((z) => z === current);
  const from = index === -1 ? 0 : index;
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, from + direction));
  return ZOOM_LEVELS[next] ?? 1;
}
