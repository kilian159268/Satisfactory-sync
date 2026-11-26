/**
 * Holt aus einem eingelesenen Spielstand nur das, was die Karte braucht: Typpfad, Position,
 * Bahnhofs- und Spielernamen. Arbeitet auf einer schmalen Struktur, damit Tests ohne
 * echten Save auskommen; `SatisfactorySave` des Parsers passt darauf.
 */
import {
  className,
  PLAYER_CLASS,
  PLAYER_STATE_CLASS,
  TRAIN_STATION_CLASS,
  TRAIN_STATION_IDENTIFIER_PATH,
} from './building-classes';
import type { MapSourceObject, MapSourcePlayer } from './build-map-data';

export interface SaveLikeObject {
  typePath: string;
  instanceName: string;
  transform?: { translation: { x: number; y: number; z: number } };
  properties?: Readonly<Record<string, unknown>>;
}

export interface SaveLike {
  levels: Readonly<Record<string, { objects: readonly SaveLikeObject[] }>>;
}

export interface MapSources {
  objects: MapSourceObject[];
  players: MapSourcePlayer[];
}

export function extractMapSources(save: SaveLike): MapSources {
  const all = Object.values(save.levels).flatMap((level) => level.objects);

  const stationNames = new Map<string, string>();
  const playerNames = new Map<string, string>();
  for (const obj of all) {
    if (obj.typePath === TRAIN_STATION_IDENTIFIER_PATH) {
      const station = refPath(obj.properties?.mStation);
      const name = textValue(obj.properties?.mStationName);
      if (station && name) stationNames.set(station, name);
    } else if (className(obj.typePath) === PLAYER_STATE_CLASS) {
      const pawn = refPath(obj.properties?.mOwnedPawn);
      const name = strValue(obj.properties?.mCachedPlayerName);
      if (pawn && name) playerNames.set(pawn, name);
    }
  }

  const objects: MapSourceObject[] = [];
  const players: MapSourcePlayer[] = [];
  for (const obj of all) {
    const t = obj.transform?.translation;
    if (!t) continue;
    const cls = className(obj.typePath);
    if (cls === PLAYER_CLASS) {
      const name = strValue(obj.properties?.mCachedPlayerName) ?? playerNames.get(obj.instanceName);
      players.push({ name, x: t.x, y: t.y });
    } else if (cls === TRAIN_STATION_CLASS) {
      objects.push({
        typePath: obj.typePath,
        x: t.x,
        y: t.y,
        name: stationNames.get(obj.instanceName),
      });
    } else {
      objects.push({ typePath: obj.typePath, x: t.x, y: t.y });
    }
  }
  return { objects, players };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** `ObjectProperty.value.pathName`. */
function refPath(prop: unknown): string | undefined {
  if (!isRecord(prop) || !isRecord(prop.value)) return undefined;
  const path = prop.value.pathName;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/** `StrProperty.value`. */
function strValue(prop: unknown): string | undefined {
  if (!isRecord(prop)) return undefined;
  return typeof prop.value === 'string' && prop.value.trim().length > 0 ? prop.value : undefined;
}

/** `TextProperty.value` – der eigentliche Text kann in `value`, `sourceText` oder `sourceFmt` stecken. */
function textValue(prop: unknown): string | undefined {
  if (!isRecord(prop)) return undefined;
  return textOf(prop.value, 0);
}

function textOf(v: unknown, depth: number): string | undefined {
  if (!isRecord(v) || depth > 4) return undefined;
  if (typeof v.value === 'string' && v.value.trim().length > 0) return v.value;
  return textOf(v.sourceText, depth + 1) ?? textOf(v.sourceFmt, depth + 1);
}
