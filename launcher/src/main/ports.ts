/**
 * Schnittstellen zur Außenwelt (Dateisystem, Uhr, Prozesse, Verschlüsselung, Log). Die Engine
 * bekommt sie injiziert; Tests ersetzen sie durch Simulationen (tests/main/helpers).
 * Echte Implementierungen: node-ports.ts.
 */

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * Minimales Dateisystem. Absichtlich ohne rekursives Löschen: Spielstände werden nur
 * verschoben (`rename`), `unlink` ist ausschließlich für eigene Temp-/Teildateien gedacht.
 */
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  /** Liest höchstens `length` Bytes ab Dateianfang. */
  readHead(path: string, length: number): Promise<Uint8Array>;
  /** Datei in Stücken lesen (Upload-Stream, Hash), optional ab Byte `start`. */
  readStream(path: string, start?: number): AsyncIterable<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Writer zum Anhängen (`append: true`) oder Neuschreiben. */
  openWriter(path: string, options: { append: boolean }): Promise<FileWriter>;
  /** Atomar umbenennen (gleiches Laufwerk); überschreibt ein vorhandenes Ziel. */
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Namen der Einträge; leeres Array, wenn der Ordner fehlt. */
  readdir(path: string): Promise<string[]>;
  /** null, wenn der Pfad nicht existiert. */
  stat(path: string): Promise<FileStat | null>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  /** Nur für eigene Temp-/Teildateien. Fehlt die Datei, passiert nichts. */
  unlink(path: string): Promise<void>;
}

export type Cancel = () => void;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): Cancel;
}

/** Führt ein Programm aus (ohne Shell) und liefert stdout; wirft bei Exit-Code ≠ 0. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

/** Electron `safeStorage` (Windows: DPAPI) als testbares Interface. */
export interface SecretCipher {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<string>;
}

export interface Logger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Wiederholt `fn` alle `ms` Millisekunden (nach Ende des vorigen Laufs). */
export function every(clock: Clock, ms: number, fn: () => Promise<void> | void): Cancel {
  let cancelled = false;
  let cancelTimer: Cancel = () => undefined;
  const schedule = (): void => {
    cancelTimer = clock.setTimeout(() => {
      void (async () => {
        try {
          await fn();
        } catch {
          // Aufrufer behandeln ihre Fehler selbst; die Schleife läuft weiter.
        } finally {
          if (!cancelled) schedule();
        }
      })();
    }, ms);
  };
  schedule();
  return () => {
    cancelled = true;
    cancelTimer();
  };
}

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}
