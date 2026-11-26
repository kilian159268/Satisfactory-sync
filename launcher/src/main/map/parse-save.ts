/**
 * Spielstand-Bytes → `MapData`. Läuft im Worker (viel RAM), ist aber eine normale Funktion,
 * damit Fehlerfälle ohne Worker testbar sind.
 */
import { Parser } from '@etothepii/satisfactory-file-parser';
import type { MapData } from '@shared/ipc';
import { buildMapData, type BuildMapOptions } from './build-map-data';
import { extractMapSources } from './extract';
import { withParserGuards } from './parser-guards';

export function mapDataFromSaveBytes(
  name: string,
  bytes: Uint8Array,
  options?: BuildMapOptions,
): MapData {
  if (bytes.byteLength === 0) throw new Error('Spielstand ist leer.');
  // Der Parser erwartet einen ArrayBuffer ohne Versatz; nur kopieren, wenn nötig.
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let save;
  try {
    save = withParserGuards(() => Parser.ParseSave(name, buffer, { throwErrors: false }));
  } catch (err) {
    throw new Error(`Spielstand konnte nicht gelesen werden: ${errorText(err)}`, { cause: err });
  }
  const sources = extractMapSources(save);
  return buildMapData(sources.objects, sources.players, options);
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'unbekannter Fehler';
}
