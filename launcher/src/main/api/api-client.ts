/**
 * HTTP-Client für den Sync-Server (Vertrag: contracts/openapi.yaml). Jede JSON-Antwort wird mit
 * den Zod-Schemas aus src/shared/api-types.ts geprüft. Upload als Stream, Download mit
 * SHA-256-Prüfung und Range-Resume.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  API_HEADERS,
  ApiErrorSchema,
  CrewListSchema,
  ForceReleaseResponseSchema,
  HealthResponseSchema,
  HeartbeatResponseSchema,
  HostInfoSchema,
  LeaseGrantSchema,
  MeResponseSchema,
  RedeemResponseSchema,
  UploadResultSchema,
  LinkCodeResponseSchema,
  VersionListSchema,
  VersionSchema,
  WorldResponseSchema,
  type CrewMember,
  type HealthResponse,
  type HeartbeatResponse,
  type HostInfo,
  type LeaseGrant,
  type LinkCodeResponse,
  type MeResponse,
  type RedeemResponse,
  type UploadResult,
  type Version,
  type WorldResponse,
} from '../../shared/api-types';
import { MapDataSchema, type MapData, type PresenceStatus } from '../../shared/ipc';
import type { Clock, FetchFn, FileSystem } from '../ports';

/** Server hat mit einem Fehler im Format `{error, message, details}` geantwortet. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Kein Netz, DNS, Verbindungsabbruch oder Timeout – der Server hat nichts gesagt. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Antwort passt nicht zum Vertrag (falsches JSON, falscher Status). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Heruntergeladene Datei hat einen anderen SHA-256 als erwartet. */
export class HashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super('Download beschädigt (SHA-256 stimmt nicht).');
    this.name = 'HashMismatchError';
  }
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

/** Fehler, nach denen ein späterer Versuch sinnvoll ist (Netz, Überlast, 5xx außer 507). */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof ApiError) {
    return error.status === 429 || (error.status >= 500 && error.status !== 507);
  }
  return false;
}

export type LeaseResult =
  { kind: 'granted'; grant: LeaseGrant } | { kind: 'held'; host: HostInfo | null; message: string };

export interface UploadRequest {
  fs: FileSystem;
  path: string;
  sha256: string;
  idempotencyKey: string;
  /** Id des Heads, auf dem aufgebaut wurde; 0 = keiner. */
  baseVersionId: number;
  /** Fencing-Token; null = bewusst ohne Lease (Konfliktkopie, Plan 7.4). */
  leaseToken: number | null;
}

export interface DownloadRequest {
  fs: FileSystem;
  versionId: number;
  expectedSha256: string;
  /** Teildatei; ist sie schon da, wird per Range fortgesetzt. */
  partPath: string;
  onProgress?: (received: number, total: number | null) => void;
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | null;
  fetch: FetchFn;
  clock: Clock;
  /** Timeout für normale JSON-Anfragen. */
  timeoutMs?: number;
  /** Timeout für Upload/Download (ganze Datei). */
  transferTimeoutMs?: number;
  /** Wird nach jeder erfolgreichen JSON-Anfrage mit der Antwortzeit aufgerufen. */
  onLatency?: (ms: number) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 30 * 60_000;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function toReadableStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null;
  private readonly fetchFn: FetchFn;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly transferTimeoutMs: number;
  private readonly onLatency: ((ms: number) => void) | undefined;

  constructor(options: ApiClientOptions) {
    this.baseUrl = trimSlash(options.baseUrl);
    this.token = options.token ?? null;
    this.fetchFn = options.fetch;
    this.clock = options.clock;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transferTimeoutMs = options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    this.onLatency = options.onLatency;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = trimSlash(url);
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  // ------------------------------------------------------------ Endpunkte

  health(): Promise<HealthResponse> {
    return this.json('GET', '/healthz', HealthResponseSchema, { auth: false });
  }

  redeem(code: string, name: string): Promise<RedeemResponse> {
    return this.json('POST', '/api/auth/redeem', RedeemResponseSchema, {
      auth: false,
      body: { code, name },
    });
  }

  createLinkCode(): Promise<LinkCodeResponse> {
    return this.json('POST', '/api/me/link-code', LinkCodeResponseSchema);
  }

  me(): Promise<MeResponse> {
    return this.json('GET', '/api/me', MeResponseSchema);
  }

  world(): Promise<WorldResponse> {
    return this.json('GET', '/api/world', WorldResponseSchema);
  }

  async acquireLease(): Promise<LeaseResult> {
    try {
      const grant = await this.json('POST', '/api/lease', LeaseGrantSchema);
      return { kind: 'granted', grant };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'lease_held') {
        const host = HostInfoSchema.safeParse(error.details);
        return { kind: 'held', host: host.success ? host.data : null, message: error.message };
      }
      throw error;
    }
  }

  heartbeat(fencingToken: number): Promise<HeartbeatResponse> {
    return this.json('PUT', '/api/lease/heartbeat', HeartbeatResponseSchema, {
      headers: { [API_HEADERS.leaseToken]: String(fencingToken) },
    });
  }

  async releaseLease(fencingToken: number): Promise<void> {
    await this.empty('DELETE', '/api/lease', {
      headers: { [API_HEADERS.leaseToken]: String(fencingToken) },
    });
  }

  forceRelease(): Promise<{ released: boolean }> {
    return this.json('POST', '/api/lease/force-release', ForceReleaseResponseSchema);
  }

  versions(): Promise<Version[]> {
    return this.json('GET', '/api/versions', VersionListSchema);
  }

  restore(versionId: number): Promise<Version> {
    return this.json('POST', `/api/versions/${versionId}/restore`, VersionSchema);
  }

  async putMap(versionId: number, map: MapData): Promise<void> {
    await this.empty('PUT', `/api/versions/${versionId}/map`, { body: map });
  }

  /** null, wenn es keine Karte gibt (404). */
  async getMap(versionId: number): Promise<MapData | null> {
    try {
      return await this.json('GET', `/api/versions/${versionId}/map`, MapDataSchema);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async presence(status: PresenceStatus): Promise<void> {
    await this.empty('PUT', '/api/presence', { body: { status } });
  }

  crew(): Promise<CrewMember[]> {
    return this.json('GET', '/api/crew', CrewListSchema);
  }

  /**
   * Upload als Stream (Plan 5.3). 201 → angenommen, 409 → Konfliktkopie gespeichert (beides
   * `UploadResult`). Alle anderen Antworten → ApiError (nichts gespeichert, Retry mit gleichem Key).
   */
  async upload(request: UploadRequest): Promise<UploadResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      [API_HEADERS.baseVersion]: String(request.baseVersionId),
      [API_HEADERS.contentSha256]: request.sha256,
      [API_HEADERS.idempotencyKey]: request.idempotencyKey,
    };
    if (request.leaseToken !== null) {
      headers[API_HEADERS.leaseToken] = String(request.leaseToken);
    }
    const { response, done } = await this.send(
      'POST',
      '/api/versions',
      {
        headers,
        body: toReadableStream(request.fs.readStream(request.path)),
        auth: true,
      },
      this.transferTimeoutMs,
    );
    try {
      if (response.status === 201 || response.status === 409) {
        const parsed = UploadResultSchema.safeParse(await this.readJsonBody(response));
        if (parsed.success) return parsed.data;
        throw new ProtocolError(`Ungültige Antwort auf den Upload (${response.status}).`);
      }
      throw await this.toApiError(response);
    } finally {
      done();
    }
  }

  /**
   * Lädt eine Version in `partPath` (setzt per Range fort, falls schon ein Teil da ist) und prüft
   * den SHA-256. Stimmt er nicht, wird die Teildatei gelöscht und HashMismatchError geworfen.
   */
  async download(request: DownloadRequest): Promise<void> {
    const { fs, partPath, expectedSha256 } = request;
    const existing = (await fs.stat(partPath))?.size ?? 0;
    const headers: Record<string, string> = {};
    if (existing > 0) {
      headers.Range = `bytes=${existing}-`;
      headers['If-Range'] = `"${expectedSha256}"`;
    }
    const { response, done } = await this.send(
      'GET',
      `/api/versions/${request.versionId}/file`,
      { headers, auth: true },
      this.transferTimeoutMs,
    );
    try {
      await this.receive(request, response, existing);
    } finally {
      done();
    }
  }

  private async receive(
    request: DownloadRequest,
    response: Response,
    existing: number,
  ): Promise<void> {
    const { fs, partPath, expectedSha256 } = request;

    let append: boolean;
    let received: number;
    let total: number | null;
    if (response.status === 206) {
      append = true;
      received = existing;
      const range = /\/(\d+)\s*$/.exec(response.headers.get('Content-Range') ?? '');
      total = range?.[1] !== undefined ? Number(range[1]) : null;
    } else if (response.status === 200) {
      append = false;
      received = 0;
      const length = response.headers.get('Content-Length');
      total = length !== null ? Number(length) : null;
    } else if (response.status === 416 && existing > 0) {
      // Teildatei ist schon vollständig (oder zu lang) – der Hash entscheidet.
      await response.body?.cancel();
      append = true;
      received = existing;
      total = existing;
    } else {
      throw await this.toApiError(response);
    }

    const announced = response.headers.get(API_HEADERS.contentSha256);
    if (announced !== null && announced.toLowerCase() !== expectedSha256.toLowerCase()) {
      await response.body?.cancel();
      await fs.unlink(partPath);
      throw new HashMismatchError(expectedSha256, announced.toLowerCase());
    }

    if (response.status !== 416) {
      const writer = await fs.openWriter(partPath, { append });
      try {
        if (response.body !== null) {
          const reader = response.body.getReader();
          for (;;) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
              chunk = await reader.read();
            } catch (error) {
              throw new NetworkError(`Download abgebrochen: ${String(error)}`);
            }
            if (chunk.done) break;
            const bytes = chunk.value as Uint8Array;
            await writer.write(bytes);
            received += bytes.byteLength;
            request.onProgress?.(received, total);
          }
        }
      } finally {
        await writer.close();
      }
    }

    const hash = createHash('sha256');
    for await (const chunk of fs.readStream(partPath)) hash.update(chunk);
    const actual = hash.digest('hex');
    if (actual !== expectedSha256.toLowerCase()) {
      await fs.unlink(partPath);
      throw new HashMismatchError(expectedSha256, actual);
    }
  }

  // ------------------------------------------------------------ Transport

  private async json<T extends z.ZodType>(
    method: string,
    path: string,
    schema: T,
    options: { auth?: boolean; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<z.infer<T>> {
    const started = this.clock.now();
    const { response, done } = await this.send(method, path, toInit(options), this.timeoutMs);
    let body: unknown;
    try {
      if (!response.ok) throw await this.toApiError(response);
      body = await this.readJsonBody(response);
    } finally {
      done();
    }
    this.onLatency?.(Math.max(0, this.clock.now() - started));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ProtocolError(`Unerwartete Antwort von ${method} ${path}.`);
    }
    return parsed.data;
  }

  private async empty(
    method: string,
    path: string,
    options: { auth?: boolean; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<void> {
    const started = this.clock.now();
    const { response, done } = await this.send(method, path, toInit(options), this.timeoutMs);
    try {
      if (!response.ok) throw await this.toApiError(response);
      await response.body?.cancel();
    } finally {
      done();
    }
    this.onLatency?.(Math.max(0, this.clock.now() - started));
  }

  private async send(
    method: string,
    path: string,
    init: {
      headers?: Record<string, string>;
      body?: string | ReadableStream<Uint8Array>;
      auth?: boolean;
    },
    timeoutMs: number,
  ): Promise<{ response: Response; done: () => void }> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    if (init.auth !== false && this.token !== null) {
      headers[API_HEADERS.authorization] = `Bearer ${this.token}`;
    }
    const controller = new AbortController();
    const abort = { timedOut: false };
    const cancelTimer = this.clock.setTimeout(() => {
      abort.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const requestInit: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      signal: controller.signal,
    };
    if (init.body !== undefined) {
      requestInit.body = init.body;
      if (typeof init.body !== 'string') requestInit.duplex = 'half';
    }
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, requestInit);
      // Timer läuft weiter, bis der Aufrufer den Body gelesen hat (`done`).
      return { response, done: cancelTimer };
    } catch (error) {
      cancelTimer();
      throw new NetworkError(
        abort.timedOut ? 'Zeitüberschreitung.' : `Server nicht erreichbar (${String(error)}).`,
        abort.timedOut,
      );
    }
  }

  private async readJsonBody(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new NetworkError(`Antwort abgebrochen: ${String(error)}`);
    }
    if (text === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProtocolError('Antwort ist kein JSON.');
    }
  }

  private async toApiError(response: Response): Promise<ApiError> {
    let body: unknown;
    try {
      body = await this.readJsonBody(response);
    } catch {
      body = null;
    }
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      return new ApiError(
        response.status,
        parsed.data.error,
        parsed.data.message,
        parsed.data.details,
      );
    }
    return new ApiError(
      response.status,
      `http_${response.status}`,
      `Server antwortet mit Status ${response.status}.`,
    );
  }
}

function toInit(options: { auth?: boolean; body?: unknown; headers?: Record<string, string> }): {
  headers: Record<string, string>;
  body?: string;
  auth?: boolean;
} {
  const headers: Record<string, string> = { ...options.headers };
  const init: { headers: Record<string, string>; body?: string; auth?: boolean } = { headers };
  if (options.auth !== undefined) init.auth = options.auth;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  return init;
}
