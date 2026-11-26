/** Hilfen fürs Dateisystem: atomares Schreiben, JSON lesen, SHA-256, freie Zielnamen. */
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import type { FileSystem } from './ports';

/** Schreibt erst eine Temp-Datei im selben Ordner und benennt sie dann um (atomar). */
export async function writeFileAtomic(
  fs: FileSystem,
  path: string,
  data: Uint8Array | string,
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(fs: FileSystem, path: string, value: unknown): Promise<void> {
  await writeFileAtomic(fs, path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Liest JSON; null, wenn die Datei fehlt oder kaputt ist. */
export async function readJson(fs: FileSystem, path: string): Promise<unknown> {
  const stat = await fs.stat(path);
  if (!stat?.isFile) return null;
  try {
    return JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as unknown;
  } catch {
    return null;
  }
}

export async function sha256File(fs: FileSystem, path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.readStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Liefert `dir/name`, oder `dir/name (2).ext` usw., falls schon belegt. Überschreibt nie. */
export async function freeTarget(fs: FileSystem, dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let i = 2; (await fs.stat(candidate)) !== null; i++) {
    candidate = join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

/** Zeitstempel für Ordnernamen: 2026-11-26T20-14-03-123Z. */
export function stampForPath(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}
