/** Echte Implementierungen der Ports (Node). Nicht in Unit-Tests verwendet. */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { Clock, CommandRunner, FileStat, FileSystem, FileWriter, Logger } from './ports';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

export const nodeFileSystem: FileSystem = {
  async readFile(path) {
    return new Uint8Array(await fsp.readFile(path));
  },
  async readHead(path, length) {
    const handle = await fsp.open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  },
  async *readStream(path, start) {
    const stream = createReadStream(path, start === undefined ? {} : { start });
    for await (const chunk of stream) {
      yield new Uint8Array(chunk as Buffer);
    }
  },
  async writeFile(path, data) {
    await fsp.writeFile(path, data);
  },
  async openWriter(path, options): Promise<FileWriter> {
    const handle = await fsp.open(path, options.append ? 'a' : 'w');
    return {
      async write(chunk) {
        await handle.write(chunk);
      },
      async close() {
        await handle.sync().catch(() => undefined);
        await handle.close();
      },
    };
  },
  async rename(from, to) {
    await fsp.rename(from, to);
  },
  async copyFile(from, to) {
    await fsp.copyFile(from, to);
  },
  async mkdir(path) {
    await fsp.mkdir(path, { recursive: true });
  },
  async readdir(path) {
    try {
      return await fsp.readdir(path);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  },
  async stat(path): Promise<FileStat | null> {
    try {
      const s = await fsp.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
  async utimes(path, atime, mtime) {
    await fsp.utimes(path, atime, mtime);
  },
  async unlink(path) {
    try {
      await fsp.unlink(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },
};

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(new Error(error.message, { cause: error }));
        else resolve(stdout);
      },
    );
  });

export const consoleLogger: Logger = {
  info: (message, ...rest) => {
    console.info(`[engine] ${message}`, ...rest);
  },
  warn: (message, ...rest) => {
    console.warn(`[engine] ${message}`, ...rest);
  },
  error: (message, ...rest) => {
    console.error(`[engine] ${message}`, ...rest);
  },
};
