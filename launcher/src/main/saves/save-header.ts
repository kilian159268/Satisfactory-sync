/**
 * Liest nur den unkomprimierten Kopf einer .sav-Datei (wenige KB), nie die ganze Datei (Plan 6.3).
 * Gleiches Format wie der Server (`SaveHeader.cs`). Das Format ist eine ANNAHME, siehe
 * game-assumptions.ts (Plan Kapitel 14 – auf Windows prüfen).
 */
import {
  HEADER_READ_BYTES,
  MAX_HEADER_STRING_BYTES,
  MAX_HEADER_VERSION,
  SAVE_NAME_FROM_HEADER_VERSION,
} from '../game-assumptions';
import type { FileSystem } from '../ports';

export interface SaveHeader {
  headerVersion: number;
  saveVersion: number;
  buildVersion: number;
  /** Erst ab Header-Version 14 vorhanden. */
  saveName: string | null;
  mapName: string;
  sessionName: string;
  playSeconds: number;
  /** .NET-Ticks (100 ns seit 0001-01-01), als bigint. */
  saveDateTicks: bigint;
}

export class SaveHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveHeaderError';
  }
}

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.byteLength) {
      throw new SaveHeaderError('Datei endet mitten im Header.');
    }
  }

  int32(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  int64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** Unreal-FString: int32 Länge inkl. Nullzeichen; positiv = 8-Bit (Latin-1), negativ = UTF-16LE. */
  fstring(): string {
    const length = this.int32();
    if (length === 0) return '';
    if (length > 0) {
      if (length > MAX_HEADER_STRING_BYTES) {
        throw new SaveHeaderError('Zeichenkette im Header zu lang.');
      }
      this.need(length);
      const raw = this.bytes.subarray(this.offset, this.offset + length - 1);
      this.offset += length;
      // Echtes ISO-8859-1 wie .NET `Encoding.Latin1` (TextDecoder('latin1') wäre windows-1252).
      let out = '';
      for (const byte of raw) out += String.fromCharCode(byte);
      return out;
    }
    if (length === -2147483648 || -length > MAX_HEADER_STRING_BYTES / 2) {
      throw new SaveHeaderError('Zeichenkette im Header zu lang.');
    }
    const chars = -length;
    this.need(chars * 2);
    const raw = this.bytes.subarray(this.offset, this.offset + (chars - 1) * 2);
    this.offset += chars * 2;
    return new TextDecoder('utf-16le').decode(raw);
  }
}

export function parseSaveHeader(bytes: Uint8Array): SaveHeader {
  const r = new Reader(bytes);
  const headerVersion = r.int32();
  if (headerVersion < 1 || headerVersion > MAX_HEADER_VERSION) {
    throw new SaveHeaderError(`Unbekannte Header-Version ${headerVersion}.`);
  }
  const saveVersion = r.int32();
  const buildVersion = r.int32();
  const saveName = headerVersion >= SAVE_NAME_FROM_HEADER_VERSION ? r.fstring() : null;
  const mapName = r.fstring();
  r.fstring(); // MapOptions
  const sessionName = r.fstring();
  const playSeconds = r.int32();
  const saveDateTicks = r.int64();
  if (sessionName.trim() === '') throw new SaveHeaderError('Sessionname fehlt.');
  if (playSeconds < 0 || saveVersion < 0 || buildVersion < 0) {
    throw new SaveHeaderError('Unplausible Werte im Header.');
  }
  return {
    headerVersion,
    saveVersion,
    buildVersion,
    saveName,
    mapName,
    sessionName,
    playSeconds,
    saveDateTicks,
  };
}

export async function readSaveHeader(fs: FileSystem, path: string): Promise<SaveHeader> {
  return parseSaveHeader(await fs.readHead(path, HEADER_READ_BYTES));
}

/** Wie readSaveHeader, aber null statt Fehler (unlesbar, fehlt, gerade im Schreiben). */
export async function tryReadSaveHeader(fs: FileSystem, path: string): Promise<SaveHeader | null> {
  try {
    return await readSaveHeader(fs, path);
  } catch {
    return null;
  }
}
