/**
 * Sicherheitsregeln des Main-Prozesses (Plan Kapitel 9). Reine Funktionen ohne Electron,
 * damit sie testbar sind. Besitz: Fundament.
 */
import { extname, isAbsolute, relative, resolve } from 'node:path';

/** Eigenes Protokoll für den Produktions-Build statt file://. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'schichtwechsel';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/** Strikte CSP für den Produktions-Build: nur eigene Dateien, kein eval, keine fremden Quellen. */
export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * CSP für `npm run dev`: Vite braucht Inline-Skript (React-Refresh-Präambel), Inline-Styles
 * (CSS-Injektion) und eine WebSocket-Verbindung für HMR. Nie im Produktions-Build verwenden.
 */
export function devCsp(devServerUrl: string): string {
  const origin = new URL(devServerUrl).origin;
  const ws = origin.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `font-src 'self' ${origin}`,
    `img-src 'self' data: ${origin}`,
    `connect-src 'self' ${origin} ${ws}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Adressen, die `shell.openExternal` öffnen darf. Steam/Epic zum Starten des Spiels über den
 * Store-Launcher (Plan 6.2), dazu die Projektseite des Servers.
 */
const EXTERNAL_PROTOCOLS = new Set(['steam:', 'com.epicgames.launcher:']);
const EXTERNAL_HTTPS_HOSTS = new Set(['sync.v3in.de']);

export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol)) return true;
  return (
    url.protocol === 'https:' &&
    EXTERNAL_HTTPS_HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * Prüft, ob eine Seiten-URL zu unserem Renderer gehört: app://schichtwechsel/… im Build,
 * die Origin des Vite-Servers im Dev-Modus.
 */
export function isTrustedRendererUrl(raw: string, devServerUrl: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST) return true;
  if (devServerUrl !== undefined) {
    return url.origin === new URL(devServerUrl).origin;
  }
  return false;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Löst eine app://-URL auf eine Datei unterhalb von `root` auf. Gibt null zurück, wenn die URL
 * nicht zu uns gehört oder aus `root` herausführen würde (Path-Traversal).
 */
export function resolveAppFile(root: string, rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname === '' || pathname === '/') pathname = '/index.html';
  const base = resolve(root);
  const file = resolve(base, `.${pathname}`);
  const rel = relative(base, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return file;
}
