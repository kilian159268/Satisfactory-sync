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

/** Ein Marker, dessen Beschriftung platziert werden soll (Maße in Bildschirmpixeln). */
export interface LabelCandidate {
  key: string;
  kind: 'cluster' | 'station' | 'player';
  at: Point;
  /** Kantenlänge (Cluster/Bahnhof) bzw. Durchmesser (Spieler) in Bildschirmpixeln. */
  size: number;
  label: string;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Geschätzte Breite eines Zeichens bei 13 px Geist (Bildschirmpixel). */
const CHAR_WIDTH = 7.5;
const LABEL_GAP = 4;

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Fläche des Markers selbst (SVG-Einheiten). Bahnhöfe sind gedrehte Quadrate. */
function shapeBox(c: LabelCandidate, scale: number): Box {
  const half =
    (c.kind === 'station' ? (c.size / 2) * Math.SQRT2 : c.kind === 'player' ? 11 : c.size / 2) + 2;
  return {
    left: c.at.x - half * scale,
    top: c.at.y - half * scale,
    right: c.at.x + half * scale,
    bottom: c.at.y + half * scale,
  };
}

/** Fläche der Beschriftung (SVG-Einheiten); Lage wie in MapMarker (Bahnhof oben, Cluster unten). */
export function labelBox(c: LabelCandidate, scale: number): Box {
  const half = c.size / 2;
  const baseline = c.kind === 'station' ? -half - 8 : half + 18;
  const width = c.label.length * CHAR_WIDTH + LABEL_GAP * 2;
  return {
    left: c.at.x - (width / 2) * scale,
    right: c.at.x + (width / 2) * scale,
    top: c.at.y + (baseline - 12 - LABEL_GAP / 2) * scale,
    bottom: c.at.y + (baseline + 4 + LABEL_GAP / 2) * scale,
  };
}

/**
 * Wählt die Beschriftungen, die sich mit nichts überlagern. Reihenfolge: Auswahl zuerst, dann
 * größere Marker. Eine Beschriftung darf weder eine schon gesetzte Beschriftung noch einen
 * fremden Marker verdecken. Spieler haben keine Beschriftung, sind aber Hindernisse.
 * `scale` = SVG-Einheiten pro Bildschirmpixel.
 */
export function pickVisibleLabels(
  candidates: readonly LabelCandidate[],
  scale: number,
  selectedKey: string | null = null,
): Set<string> {
  const shapes = candidates.map((c) => ({ key: c.key, box: shapeBox(c, scale) }));
  const ordered = candidates
    .filter((c) => c.kind !== 'player' && c.label !== '')
    .sort((a, b) => {
      if (a.key === selectedKey) return -1;
      if (b.key === selectedKey) return 1;
      return b.size - a.size || a.key.localeCompare(b.key);
    });
  const placed: Box[] = [];
  const visible = new Set<string>();
  for (const c of ordered) {
    const box = labelBox(c, scale);
    const blocked =
      c.key !== selectedKey &&
      (placed.some((p) => overlaps(p, box)) ||
        shapes.some((s) => s.key !== c.key && overlaps(s.box, box)));
    if (blocked) continue;
    placed.push(box);
    visible.add(c.key);
  }
  return visible;
}
