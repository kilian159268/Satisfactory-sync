import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROD_CSP,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  resolveAppFile,
} from '../../src/main/security';

describe('isAllowedExternalUrl', () => {
  it('erlaubt Store-Launcher und den Sync-Server', () => {
    expect(isAllowedExternalUrl('steam://run/526870')).toBe(true);
    expect(isAllowedExternalUrl('com.epicgames.launcher://apps/CrabEA?action=launch')).toBe(true);
    expect(isAllowedExternalUrl('https://sync.v3in.de/')).toBe(true);
  });

  it('lehnt alles andere ab', () => {
    for (const url of [
      'http://sync.v3in.de/',
      'https://sync.v3in.de.evil.example/',
      'https://evil.example/',
      'https://user@sync.v3in.de/',
      'file:///C:/Windows/System32/cmd.exe',
      'javascript:alert(1)',
      'ms-settings:',
      'kein url',
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
  });
});

describe('isTrustedRendererUrl', () => {
  it('app:// immer, Dev-Server nur im Dev-Modus', () => {
    expect(isTrustedRendererUrl('app://schichtwechsel/index.html', undefined)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5173/', undefined)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isTrustedRendererUrl('file:///index.html', 'http://localhost:5173')).toBe(false);
  });
});

describe('resolveAppFile', () => {
  const root = resolve('/app/out/renderer');

  it('löst Dateien unterhalb von root auf', () => {
    expect(resolveAppFile(root, 'app://schichtwechsel/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://schichtwechsel/assets/index-abc.js')).toBe(
      join(root, 'assets', 'index-abc.js'),
    );
  });

  it('normalisierte Punkt-Segmente bleiben innerhalb von root', () => {
    // Der URL-Parser löst /../ und /%2e%2e/ bereits auf – das Ergebnis liegt in root.
    for (const url of [
      'app://schichtwechsel/../main/index.js',
      'app://schichtwechsel/%2e%2e/main/index.js',
    ]) {
      expect(resolveAppFile(root, url), url).toBe(join(root, 'main', 'index.js'));
    }
  });

  it('verhindert Path-Traversal und fremde Hosts', () => {
    for (const url of [
      'app://schichtwechsel/..%2fmain%2findex.js',
      'app://schichtwechsel/..%5cmain%5cindex.js',
      'app://schichtwechsel/a%00.js',
      'app://other/index.html',
      'file:///etc/passwd',
    ]) {
      expect(resolveAppFile(root, url), url).toBeNull();
    }
  });
});

describe('CSP', () => {
  it('enthält kein unsafe-eval/unsafe-inline und keine fremden Quellen', () => {
    expect(PROD_CSP).not.toMatch(/unsafe/);
    expect(PROD_CSP).not.toMatch(/https?:/);
    expect(PROD_CSP).toContain("default-src 'none'");
  });
});
