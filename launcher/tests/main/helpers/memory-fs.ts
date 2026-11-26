/** Simuliertes Dateisystem im Speicher (implementiert FileSystem), protokolliert Löschungen. */
import { basename, dirname, resolve, sep } from 'node:path';
import type { FileStat, FileSystem, FileWriter } from '../../../src/main/ports';

interface Entry {
  data: Uint8Array;
  mtimeMs: number;
}

export class MemoryFs implements FileSystem {
  readonly files = new Map<string, Entry>();
  readonly dirs = new Set<string>();
  /** Jeder unlink-Aufruf (Pfad), auch für nicht vorhandene Dateien. */
  readonly unlinks: string[] = [];
  readonly renames: { from: string; to: string }[] = [];
  /** Wird vor jeder Operation aufgerufen; wirft → Operation scheitert (simulierter Absturz/IO-Fehler). */
  hook: ((op: string, path: string) => void) | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(path: string): string {
    return resolve(path);
  }

  private check(op: string, path: string): void {
    this.hook?.(op, this.key(path));
  }

  private ensureDir(path: string): void {
    let dir = this.key(path);
    while (!this.dirs.has(dir)) {
      this.dirs.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  private notFound(path: string): Error {
    return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }

  // -------- Testhilfen
  put(path: string, data: Uint8Array | string, mtimeMs = this.now()): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.ensureDir(dirname(this.key(path)));
    this.files.set(this.key(path), { data: new Uint8Array(bytes), mtimeMs });
  }
  get(path: string): Uint8Array | undefined {
    return this.files.get(this.key(path))?.data;
  }
  has(path: string): boolean {
    return this.files.has(this.key(path));
  }
  text(path: string): string {
    const d = this.get(path);
    if (d === undefined) throw this.notFound(path);
    return new TextDecoder().decode(d);
  }
  /** Alle Dateien unterhalb eines Ordners (rekursiv). */
  list(dir: string): string[] {
    const prefix = this.key(dir) + sep;
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  // -------- FileSystem
  readFile(path: string): Promise<Uint8Array> {
    this.check('readFile', path);
    const e = this.files.get(this.key(path));
    if (!e) return Promise.reject(this.notFound(path));
    return Promise.resolve(new Uint8Array(e.data));
  }
  async readHead(path: string, length: number): Promise<Uint8Array> {
    return (await this.readFile(path)).slice(0, length);
  }
  async *readStream(path: string, start = 0): AsyncIterable<Uint8Array> {
    const data = await this.readFile(path);
    const chunk = 64 * 1024;
    for (let i = start; i < data.length; i += chunk) yield data.slice(i, i + chunk);
  }
  writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.check('writeFile', path);
    if (!this.dirs.has(dirname(this.key(path)))) return Promise.reject(this.notFound(path));
    this.put(path, data);
    return Promise.resolve();
  }
  openWriter(path: string, options: { append: boolean }): Promise<FileWriter> {
    this.check('openWriter', path);
    const key = this.key(path);
    if (!this.dirs.has(dirname(key))) return Promise.reject(this.notFound(path));
    if (!options.append || !this.files.has(key)) this.put(key, new Uint8Array());
    return Promise.resolve({
      write: (chunk: Uint8Array) => {
        const e = this.files.get(key);
        if (!e) return Promise.reject(this.notFound(path));
        const merged = new Uint8Array(e.data.length + chunk.length);
        merged.set(e.data);
        merged.set(chunk, e.data.length);
        this.files.set(key, { data: merged, mtimeMs: this.now() });
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  }
  rename(from: string, to: string): Promise<void> {
    this.check('rename', from);
    const e = this.files.get(this.key(from));
    if (!e) return Promise.reject(this.notFound(from));
    if (!this.dirs.has(dirname(this.key(to)))) return Promise.reject(this.notFound(to));
    this.files.delete(this.key(from));
    this.files.set(this.key(to), e);
    this.renames.push({ from: this.key(from), to: this.key(to) });
    return Promise.resolve();
  }
  copyFile(from: string, to: string): Promise<void> {
    this.check('copyFile', from);
    const e = this.files.get(this.key(from));
    if (!e) return Promise.reject(this.notFound(from));
    if (!this.dirs.has(dirname(this.key(to)))) return Promise.reject(this.notFound(to));
    this.files.set(this.key(to), { data: new Uint8Array(e.data), mtimeMs: this.now() });
    return Promise.resolve();
  }
  mkdir(path: string): Promise<void> {
    this.check('mkdir', path);
    this.ensureDir(path);
    return Promise.resolve();
  }
  readdir(path: string): Promise<string[]> {
    const dir = this.key(path);
    const out = new Set<string>();
    for (const k of [...this.files.keys(), ...this.dirs]) {
      if (k !== dir && dirname(k) === dir) out.add(basename(k));
    }
    return Promise.resolve([...out].sort());
  }
  stat(path: string): Promise<FileStat | null> {
    const k = this.key(path);
    const e = this.files.get(k);
    if (e)
      return Promise.resolve({
        size: e.data.length,
        mtimeMs: e.mtimeMs,
        isFile: true,
        isDirectory: false,
      });
    if (this.dirs.has(k))
      return Promise.resolve({ size: 0, mtimeMs: 0, isFile: false, isDirectory: true });
    return Promise.resolve(null);
  }
  utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const e = this.files.get(this.key(path));
    if (!e) return Promise.reject(this.notFound(path));
    e.mtimeMs = mtime.getTime();
    return Promise.resolve();
  }
  unlink(path: string): Promise<void> {
    this.check('unlink', path);
    this.unlinks.push(this.key(path));
    this.files.delete(this.key(path));
    return Promise.resolve();
  }
}
