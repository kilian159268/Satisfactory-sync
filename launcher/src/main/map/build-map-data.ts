/**
 * Reine Umrechnung: ausgelesene Spielobjekte → kleine `MapData` (Plan 6.6).
 * Keine Ein-/Ausgabe, kein Parser – läuft im Worker, ist aber ohne ihn testbar.
 */
import type { MapData } from '@shared/ipc';
import {
  WORLD_BOUNDS_M,
  className,
  isMapBuilding,
  readableTypeName,
  TRAIN_STATION_CLASS,
} from './building-classes';

/** Versionsnummer des `MapData`-Formats. */
export const MAP_DATA_VERSION = 1;

/** Objekt mit Position in Spieleinheiten (cm). Bahnhöfe dürfen einen Namen tragen. */
export interface MapSourceObject {
  typePath: string;
  x: number;
  y: number;
  name?: string | undefined;
}

/** Spielerfigur mit Position in Spieleinheiten (cm). */
export interface MapSourcePlayer {
  name?: string | undefined;
  x: number;
  y: number;
}

export interface BuildMapOptions {
  /** Kantenlänge einer Rasterzelle in Metern (Standard 200). */
  cellSizeM?: number;
  /** Höchstzahl Cluster; darüber wird das Raster gröber, notfalls fallen die kleinsten weg. */
  maxClusters?: number;
  maxStations?: number;
  maxPlayers?: number;
}

const DEFAULTS = { cellSizeM: 200, maxClusters: 400, maxStations: 300, maxPlayers: 64 };
const CM_PER_M = 100;
const TOP_TYPES = 3;
/** Rand um den Inhalt, damit einzelne Punkte nicht am Kartenrand kleben. */
const BOUNDS_PADDING_M = 100;
/** Ein Cluster reicht höchstens so viele Zellen vom Startpunkt weg (1 → max. 3×3 Zellen). */
const CLUSTER_REACH_CELLS = 1;
/** So oft wird das Raster höchstens verdoppelt, bevor die kleinsten Cluster wegfallen. */
const MAX_COARSENING_STEPS = 4;
const MAX_NAME_LENGTH = 64;

interface Point {
  x: number;
  y: number;
}

interface Building extends Point {
  type: string;
}

type Cluster = MapData['clusters'][number];

export function buildMapData(
  objects: readonly MapSourceObject[],
  players: readonly MapSourcePlayer[],
  options: BuildMapOptions = {},
): MapData {
  const opts = { ...DEFAULTS, ...options };
  const buildings: Building[] = [];
  const stations: MapData['stations'] = [];

  for (const obj of objects) {
    if (!isFinitePoint(obj)) continue;
    const point = toMeters(obj);
    if (className(obj.typePath) === TRAIN_STATION_CLASS) {
      stations.push({ name: cleanName(obj.name) ?? `Bahnhof ${stations.length + 1}`, ...point });
    } else if (isMapBuilding(obj.typePath)) {
      buildings.push({ type: readableTypeName(obj.typePath), ...point });
    }
  }

  const mapPlayers: MapData['players'] = [];
  for (const player of players) {
    if (!isFinitePoint(player)) continue;
    mapPlayers.push({
      name: cleanName(player.name) ?? `Spieler ${mapPlayers.length + 1}`,
      ...toMeters(player),
    });
  }

  const clusters = clusterBuildings(buildings, opts.cellSizeM, opts.maxClusters);
  const keptStations = stations.slice(0, opts.maxStations);
  const keptPlayers = mapPlayers.slice(0, opts.maxPlayers);

  return {
    version: MAP_DATA_VERSION,
    clusters,
    stations: keptStations,
    players: keptPlayers,
    bounds: computeBounds([...buildings, ...keptStations, ...keptPlayers]),
  };
}

/**
 * Raster-Clustering: Gebäude in Zellen zählen, dann von der dichtesten Zelle aus benachbarte
 * Zellen (8er-Nachbarschaft, höchstens {@link CLUSTER_REACH_CELLS} vom Start entfernt)
 * zusammenführen. So wird eine große Fabrik zu wenigen Punkten, ohne dass eine durchgehend
 * bebaute Gegend zu einem einzigen Riesen-Cluster verschmilzt.
 */
function clusterBuildings(
  buildings: readonly Building[],
  cellSizeM: number,
  maxClusters: number,
): Cluster[] {
  let size = cellSizeM;
  let clusters = clusterOnGrid(buildings, size);
  for (let step = 0; clusters.length > maxClusters && step < MAX_COARSENING_STEPS; step++) {
    size *= 2;
    clusters = clusterOnGrid(buildings, size);
  }
  return clusters.slice(0, Math.max(0, maxClusters));
}

interface Cell {
  cx: number;
  cy: number;
  items: Building[];
}

function clusterOnGrid(buildings: readonly Building[], cellSizeM: number): Cluster[] {
  const cells = new Map<string, Cell>();
  for (const b of buildings) {
    const cx = Math.floor(b.x / cellSizeM);
    const cy = Math.floor(b.y / cellSizeM);
    const key = cellKey(cx, cy);
    let cell = cells.get(key);
    if (!cell) {
      cell = { cx, cy, items: [] };
      cells.set(key, cell);
    }
    cell.items.push(b);
  }

  // Dichteste Zellen zuerst; bei Gleichstand nach Koordinate, damit das Ergebnis stabil ist.
  const seeds = [...cells.values()].sort(
    (a, b) => b.items.length - a.items.length || a.cx - b.cx || a.cy - b.cy,
  );
  const assigned = new Set<string>();
  const clusters: Cluster[] = [];

  for (const seed of seeds) {
    const seedKey = cellKey(seed.cx, seed.cy);
    if (assigned.has(seedKey)) continue;
    assigned.add(seedKey);
    const members: Cell[] = [seed];
    const queue: Cell[] = [seed];
    for (let cell = queue.shift(); cell; cell = queue.shift()) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nx = cell.cx + dx;
          const ny = cell.cy + dy;
          if (Math.abs(nx - seed.cx) > CLUSTER_REACH_CELLS) continue;
          if (Math.abs(ny - seed.cy) > CLUSTER_REACH_CELLS) continue;
          const key = cellKey(nx, ny);
          const neighbour = cells.get(key);
          if (!neighbour || assigned.has(key)) continue;
          assigned.add(key);
          members.push(neighbour);
          queue.push(neighbour);
        }
      }
    }
    clusters.push(toCluster(`c${seed.cx}_${seed.cy}`, members));
  }

  return clusters.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function toCluster(id: string, cells: readonly Cell[]): Cluster {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const types = new Map<string, number>();
  for (const cell of cells) {
    for (const b of cell.items) {
      sumX += b.x;
      sumY += b.y;
      count++;
      types.set(b.type, (types.get(b.type) ?? 0) + 1);
    }
  }
  const topTypes = [...types.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TYPES)
    .map(([type]) => type);
  return { id, x: round1(sumX / count), y: round1(sumY / count), count, topTypes };
}

function computeBounds(points: readonly Point[]): MapData['bounds'] {
  if (points.length === 0) return { ...WORLD_BOUNDS_M };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    minX: round1(minX - BOUNDS_PADDING_M),
    minY: round1(minY - BOUNDS_PADDING_M),
    maxX: round1(maxX + BOUNDS_PADDING_M),
    maxY: round1(maxY + BOUNDS_PADDING_M),
  };
}

function isFinitePoint(p: { x: unknown; y: unknown }): boolean {
  return (
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y)
  );
}

function toMeters(p: Point): Point {
  return { x: round1(p.x / CM_PER_M), y: round1(p.y / CM_PER_M) };
}

function cleanName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  // Steuerzeichen (< U+0020, U+007F) entfernen; ohne Steuerzeichen-Regex (ESLint no-control-regex).
  let visible = '';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) visible += name.charAt(i);
  }
  const trimmed = visible.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return undefined;
  // Länge zählt wie im Schema in UTF-16-Einheiten; kein halbes Surrogatpaar am Ende lassen.
  let cut = trimmed.slice(0, MAX_NAME_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < trimmed.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
