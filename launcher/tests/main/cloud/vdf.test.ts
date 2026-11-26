import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getChild, getPath, parseVdf, VdfParseError } from '../../../src/main/cloud/vdf';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('parseVdf', () => {
  it('liest verschachtelte Blöcke einer localconfig.vdf', () => {
    const doc = parseVdf(fixture('localconfig.vdf'));
    expect(
      getPath(doc, [
        'UserLocalConfigStore',
        'Software',
        'Valve',
        'Steam',
        'apps',
        '526870',
        'Playtime',
      ]),
    ).toBe('12345');
    expect(getPath(doc, ['UserLocalConfigStore', 'friends', 'PersonaName'])).toBe('Test "Pioneer"');
  });

  it('versteht Escapes, Kommentare, unquotierte Tokens und Bedingungen', () => {
    const doc = parseVdf(
      '// Kommentar\n"root" {\n  "a" "x\\\\y\\tz" [$WIN32]\n  b 12 // Rest\n  "c" { } \n}\n',
    );
    expect(doc).toEqual({ root: { a: 'x\\y\tz', b: '12', c: {} } });
  });

  it('akzeptiert BOM, CRLF und Blöcke direkt hinter dem Schlüssel', () => {
    const doc = parseVdf('﻿"root"{"k""v"}\r\n');
    expect(getPath(doc, ['root', 'k'])).toBe('v');
  });

  it('führt doppelte Blöcke zusammen, der letzte Wert gewinnt', () => {
    const doc = parseVdf('"r" { "a" { "x" "1" } "a" { "y" "2" } "v" "1" "v" "2" }');
    expect(doc).toEqual({ r: { a: { x: '1', y: '2' }, v: '2' } });
  });

  it('legt __proto__ als normalen Schlüssel ab (kein Prototype-Pollution)', () => {
    const doc = parseVdf('"__proto__" { "polluted" "1" }');
    expect(getPath(doc, ['__proto__', 'polluted'])).toBe('1');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['offener Block', '"r" { "a" "b"'],
    ['überzähliges }', '"r" "v" }'],
    ['Wert fehlt', '"r"'],
    ['offene Zeichenkette', '"r" "abc'],
    ['Block ohne Schlüssel', '{ "a" "b" }'],
    ['Bedingung ohne Ende', '"r" "v" [$WIN32'],
  ])('wirft VdfParseError bei %s', (_name, text) => {
    expect(() => parseVdf(text)).toThrow(VdfParseError);
  });

  it('wirft bei zu tiefer Verschachtelung statt abzustürzen', () => {
    const text = '"a" {'.repeat(200) + '}'.repeat(200);
    expect(() => parseVdf(text)).toThrow(VdfParseError);
  });
});

describe('getChild', () => {
  it('vergleicht Schlüssel ohne Groß-/Kleinschreibung', () => {
    const doc = parseVdf('"r" { "CloudEnabled" "0" }');
    expect(getChild(getChild(doc, 'R'), 'cloudenabled')).toBe('0');
  });

  it('liefert undefined für Werte statt Blöcke', () => {
    expect(getChild('text', 'x')).toBeUndefined();
    expect(getPath(parseVdf('"r" "v"'), ['r', 'x'])).toBeUndefined();
  });
});
