/**
 * Schutz vor einem Absturz des ganzen Prozesses beim Einlesen kaputter Spielstände.
 *
 * @etothepii/satisfactory-file-parser legt Arrays in der Größe von Längenangaben aus der Datei
 * an (`new Array(n).fill(…)`, z. B. bei Texten mit negativer Länge = UTF-16). Bei Müll-Daten
 * ist `n` riesig, und V8 bricht dann mit „invalid table size“ den GANZEN Prozess ab – auch aus
 * einem Worker-Thread heraus, `resourceLimits` greift dabei nicht (mit Node 24 nachgestellt).
 *
 * Darum wird während des (synchronen) Parsens
 * - `ByteReader.readString`/`readBytes` gegen das Dateiende geprüft und
 * - der globale `Array`-Konstruktor so gekapselt, dass absurde Längen einen normalen,
 *   abfangbaren `RangeError` werfen.
 * Nach dem Parsen wird beides zurückgesetzt.
 */
import { ByteReader } from '@etothepii/satisfactory-file-parser';

/** Größte Array-Länge, die der Parser anlegen darf (≈ 33 Mio. Einträge). */
export const MAX_PARSER_ARRAY_LENGTH = 1 << 25;

interface GuardableReader {
  readString: (this: GuardableReader) => string;
  readBytes: (this: GuardableReader, count: number) => Uint8Array;
  readInt32: (this: GuardableReader) => number;
  jumpTo: (this: GuardableReader, pos: number) => void;
  getBufferPosition: () => number;
  getBufferLength: () => number;
}

let active = 0;
let restore: (() => void) | undefined;

/** Führt `fn` mit aktivem Schutz aus (verschachtelbar). */
export function withParserGuards<T>(fn: () => T): T {
  if (active === 0) restore = install();
  active++;
  try {
    return fn();
  } finally {
    active--;
    if (active === 0) {
      restore?.();
      restore = undefined;
    }
  }
}

function install(): () => void {
  const proto = ByteReader.prototype as unknown as GuardableReader;
  const originalReadString = proto.readString;
  const originalReadBytes = proto.readBytes;

  proto.readString = function guardedReadString(this: GuardableReader): string {
    const start = this.getBufferPosition();
    const remaining = this.getBufferLength() - start - 4;
    if (remaining >= 0) {
      const length = this.readInt32();
      this.jumpTo(start);
      const bytes = length < 0 ? -length * 2 : length;
      if (bytes > remaining) {
        throw new RangeError(`Ungültige Textlänge ${length} an Position ${start}.`);
      }
    }
    return originalReadString.call(this);
  };

  proto.readBytes = function guardedReadBytes(this: GuardableReader, count: number): Uint8Array {
    const remaining = this.getBufferLength() - this.getBufferPosition();
    if (!Number.isInteger(count) || count < 0 || count > remaining) {
      throw new RangeError(
        `Ungültige Byte-Anzahl ${count} an Position ${this.getBufferPosition()}.`,
      );
    }
    return originalReadBytes.call(this, count);
  };

  const OriginalArray = globalThis.Array;
  const check = (args: readonly unknown[]): void => {
    const [n] = args;
    if (args.length === 1 && typeof n === 'number' && n > MAX_PARSER_ARRAY_LENGTH) {
      throw new RangeError(`Ungültige Anzahl ${n} im Spielstand.`);
    }
  };
  const GuardedArray: ArrayConstructor = new Proxy(OriginalArray, {
    construct(target, args, newTarget) {
      check(args);
      return Reflect.construct(
        target,
        args,
        newTarget === GuardedArray ? target : newTarget,
      ) as object;
    },
    apply(target, thisArg, args) {
      check(args);
      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });
  globalThis.Array = GuardedArray;

  return () => {
    proto.readString = originalReadString;
    proto.readBytes = originalReadBytes;
    globalThis.Array = OriginalArray;
  };
}
