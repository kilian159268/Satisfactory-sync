/**
 * Kleiner, toleranter Parser für Valves Text-KeyValues (VDF), wie sie Steam in
 * `localconfig.vdf`, `sharedconfig.vdf` und `loginusers.vdf` schreibt.
 *
 * Unterstützt: Schlüssel/Werte in Anführungszeichen oder ohne, verschachtelte Blöcke `{ … }`,
 * Escapes (`\"`, `\\`, `\n`, `\t`), Kommentare (`// …`) und Bedingungen wie `[$WIN32]`
 * (werden ignoriert). Doppelte Blöcke werden zusammengeführt, bei doppelten Werten gewinnt der
 * letzte. Binäre VDF (z. B. `appinfo.vdf`) wird nicht unterstützt.
 */

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

export class VdfParseError extends Error {
  constructor(message: string, offset: number) {
    super(`VDF ungültig an Position ${offset}: ${message}`);
    this.name = 'VdfParseError';
  }
}

/** Maximale Verschachtelungstiefe – schützt vor Stack-Überlauf bei kaputten Dateien. */
const MAX_DEPTH = 64;

type Token =
  | { kind: 'string'; value: string; offset: number }
  | { kind: 'open'; offset: number }
  | { kind: 'close'; offset: number };

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '"': '"' };

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '﻿';
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (isSpace(ch)) {
      i++;
    } else if (ch === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i++;
    } else if (ch === '{') {
      tokens.push({ kind: 'open', offset: i });
      i++;
    } else if (ch === '}') {
      tokens.push({ kind: 'close', offset: i });
      i++;
    } else if (ch === '[') {
      // Bedingung wie [$WIN32] oder [!$X360] – für uns ohne Bedeutung.
      const end = text.indexOf(']', i);
      if (end === -1) throw new VdfParseError('Bedingung ohne „]“', i);
      i = end + 1;
    } else if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      for (;;) {
        if (i >= text.length) throw new VdfParseError('Zeichenkette ohne Ende', start);
        const c = text.charAt(i);
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\' && i + 1 < text.length) {
          const next = text.charAt(i + 1);
          value += ESCAPES[next] ?? `\\${next}`;
          i += 2;
        } else {
          value += c;
          i++;
        }
      }
      tokens.push({ kind: 'string', value, offset: start });
    } else {
      const start = i;
      while (i < text.length) {
        const c = text.charAt(i);
        if (isSpace(c) || c === '{' || c === '}' || c === '"') break;
        i++;
      }
      tokens.push({ kind: 'string', value: text.slice(start, i), offset: start });
    }
  }
  return tokens;
}

function emptyObject(): VdfObject {
  return Object.create(null) as VdfObject;
}

function assign(target: VdfObject, key: string, value: VdfValue): void {
  const existing = target[key];
  if (typeof existing === 'object' && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assign(existing, k, v);
  } else {
    target[key] = value;
  }
}

/** Parst VDF-Text in ein Objekt (ohne Prototyp). Wirft `VdfParseError` bei kaputtem Aufbau. */
export function parseVdf(text: string): VdfObject {
  const tokens = tokenize(text);
  let pos = 0;

  function parseBlock(depth: number, closed: boolean): VdfObject {
    if (depth > MAX_DEPTH)
      throw new VdfParseError('zu tief verschachtelt', tokens[pos]?.offset ?? 0);
    const obj = emptyObject();
    for (;;) {
      const token = tokens[pos];
      if (token === undefined) {
        if (closed) throw new VdfParseError('„}“ fehlt', text.length);
        return obj;
      }
      if (token.kind === 'close') {
        if (!closed) throw new VdfParseError('unerwartetes „}“', token.offset);
        pos++;
        return obj;
      }
      if (token.kind === 'open') throw new VdfParseError('Block ohne Schlüssel', token.offset);
      pos++;
      const next = tokens[pos];
      if (next === undefined) throw new VdfParseError('Wert fehlt', text.length);
      if (next.kind === 'open') {
        pos++;
        assign(obj, token.value, parseBlock(depth + 1, true));
      } else if (next.kind === 'string') {
        pos++;
        assign(obj, token.value, next.value);
      } else {
        throw new VdfParseError('Wert fehlt', next.offset);
      }
    }
  }

  return parseBlock(0, false);
}

/** Liest einen Unterknoten; Schlüssel werden ohne Groß-/Kleinschreibung verglichen (Steam ist da uneinheitlich). */
export function getChild(node: VdfValue | undefined, key: string): VdfValue | undefined {
  if (node === undefined || typeof node === 'string') return undefined;
  const direct = node[key];
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(node)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Folgt einem Pfad aus Schlüsseln (ohne Groß-/Kleinschreibung). */
export function getPath(node: VdfValue | undefined, path: readonly string[]): VdfValue | undefined {
  let current = node;
  for (const key of path) {
    current = getChild(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}
