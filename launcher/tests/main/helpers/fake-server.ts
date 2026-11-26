/**
 * Simulierter Sync-Server (Verhalten nach contracts/openapi.yaml und Plan 5.3) als `fetch`.
 * Hält Lease mit Ablauf, Fencing-Zähler, Versionen, Idempotency-Keys, Anwesenheit, Karten.
 */
import { createHash } from 'node:crypto';
import type { Version } from '../../../src/shared/api-types';
import { parseSaveHeader } from '../../../src/main/saves/save-header';
import type { FakeClock } from './fake-clock';

const LEASE_MS = 120_000;

export interface Lease {
  user: string;
  token: number;
  leaseId: string;
  since: number;
  expiresAt: number;
}

export type Interceptor = (req: {
  method: string;
  path: string;
  headers: Headers;
  user: string | null;
}) => Response | 'network' | 'pass' | undefined;

function sha(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function err(status: number, error: string, message: string, details: unknown = null): Response {
  return json(status, { error, message, details });
}

export class FakeServer {
  readonly tokens = new Map<string, string>(); // token → name
  readonly invites = new Map<string, boolean>(); // code → frei
  lease: Lease | null = null;
  fencing = 0;
  versions: Version[] = [];
  files = new Map<number, Uint8Array>();
  headId: number | null = null;
  sessionName: string | null = null;
  readonly idempotency = new Map<string, { status: number; body: unknown }>();
  readonly presence = new Map<string, { status: string; at: number }>();
  readonly maps = new Map<number, unknown>();
  readonly log: { method: string; path: string; user: string | null; headers: Headers }[] = [];
  /** Alle Anfragen scheitern mit Netzfehler. */
  offline = false;
  diskFull = false;
  /** Download liefert falsche Bytes (Hash stimmt nicht). */
  corruptDownloads = false;
  /** Nächster Download bricht nach so vielen Bytes ab. */
  cutNextDownloadAt: number | null = null;
  interceptors: Interceptor[] = [];
  private nextNumber = 1;
  private nextConflict = 1;
  private nextId = 1;

  constructor(private readonly clock: FakeClock) {}

  addUser(name: string, token = `token-${name}`): string {
    this.tokens.set(token, name);
    return token;
  }

  /** Version direkt anlegen (als Head), z. B. Ausgangslage. */
  seedVersion(data: Uint8Array, uploadedBy = 'Alt'): Version {
    const header = parseSaveHeader(data);
    const v = this.addVersion(data, header.playSeconds, header.buildVersion, header.sessionName, uploadedBy, 'normal', null, null);
    this.headId = v.id;
    this.sessionName ??= header.sessionName;
    return v;
  }

  head(): Version | null {
    return this.versions.find((v) => v.id === this.headId) ?? null;
  }

  activeLease(): Lease | null {
    return this.lease !== null && this.lease.expiresAt > this.clock.now() ? this.lease : null;
  }

  /** Lease eines anderen Spielers direkt vergeben. */
  grantLease(user: string): Lease {
    this.fencing++;
    const now = this.clock.now();
    this.lease = { user, token: this.fencing, leaseId: `lease-${this.fencing}`, since: now, expiresAt: now + LEASE_MS };
    return this.lease;
  }

  requests(method: string, path: string): number {
    return this.log.filter((l) => l.method === method && l.path === path).length;
  }

  private addVersion(
    data: Uint8Array,
    playSeconds: number,
    buildVersion: number,
    sessionName: string,
    uploadedBy: string,
    type: 'normal' | 'konflikt',
    baseVersionId: number | null,
    conflictReason: Version['conflictReason'],
  ): Version {
    const id = this.nextId++;
    const number = type === 'normal' ? this.nextNumber++ : null;
    const v: Version = {
      id,
      number,
      label: type === 'normal' ? String(number) : `K-${this.nextConflict++}`,
      sha256: sha(data),
      size: data.length,
      playSeconds,
      buildVersion,
      sessionName,
      uploadedBy,
      uploadedAt: new Date(this.clock.now()).toISOString(),
      type,
      baseVersionId,
      conflictReason,
      restoredFrom: null,
      pruned: false,
      hasMap: false,
    };
    this.versions.unshift(v);
    this.files.set(id, data);
    return v;
  }

  private hostInfo(): unknown {
    if (this.lease === null) return null;
    return {
      name: this.lease.user,
      since: new Date(this.lease.since).toISOString(),
      expiresAt: new Date(this.lease.expiresAt).toISOString(),
      expired: this.lease.expiresAt <= this.clock.now(),
    };
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname;
    const headers = new Headers(init.headers);
    const auth = headers.get('Authorization');
    const user = auth?.startsWith('Bearer ') === true ? (this.tokens.get(auth.slice(7)) ?? null) : null;
    this.log.push({ method, path, user, headers });
    if (this.offline) throw new TypeError('fetch failed');
    for (const icpt of this.interceptors) {
      const r = icpt({ method, path, headers, user });
      if (r === 'network') throw new TypeError('fetch failed');
      if (r instanceof Response) return r;
    }
    const body =
      init.body === undefined || init.body === null
        ? new Uint8Array()
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    return this.route(method, path, headers, user, body);
  };

  private route(method: string, path: string, headers: Headers, user: string | null, body: Uint8Array): Response {
    const now = this.clock.now();
    if (method === 'POST' && path === '/api/auth/redeem') {
      const req = JSON.parse(new TextDecoder().decode(body)) as { code: string; name: string };
      if (this.invites.get(req.code) !== true) return err(401, 'invite_invalid', 'Einladungscode ist ungültig oder schon benutzt.');
      if ([...this.tokens.values()].includes(req.name)) return err(409, 'name_taken', 'Name ist schon vergeben.');
      this.invites.set(req.code, false);
      const token = `token-${req.name}`;
      this.tokens.set(token, req.name);
      return json(200, { token, name: req.name });
    }
    if (path === '/healthz') return json(200, { status: 'ok', time: new Date(now).toISOString() });
    if (user === null) return err(401, 'unauthorized', 'Nicht angemeldet.');

    if (method === 'GET' && path === '/api/me') return json(200, { name: user });
    if (method === 'GET' && path === '/api/world') {
      return json(200, {
        sessionName: this.sessionName,
        head: this.head(),
        host: this.hostInfo(),
        serverTime: new Date(now).toISOString(),
      });
    }
    if (method === 'POST' && path === '/api/lease') {
      const active = this.activeLease();
      if (active !== null) {
        return err(409, 'lease_held', `${active.user} hostet gerade.`, this.hostInfo());
      }
      const lease = this.grantLease(user);
      return json(200, {
        leaseId: lease.leaseId,
        fencingToken: lease.token,
        headVersionId: this.headId ?? 0,
        expiresAt: new Date(lease.expiresAt).toISOString(),
        head: this.head(),
      });
    }
    if (path === '/api/lease/heartbeat' || (method === 'DELETE' && path === '/api/lease')) {
      const token = Number(headers.get('Lease-Token'));
      const active = this.activeLease();
      if (active === null || active.token !== token || active.user !== user) {
        return err(409, 'lease_lost', 'Hostrecht verloren.');
      }
      if (method === 'DELETE') {
        this.lease = null;
        return json(204, null);
      }
      active.expiresAt = now + LEASE_MS;
      return json(200, { expiresAt: new Date(active.expiresAt).toISOString() });
    }
    if (method === 'GET' && path === '/api/versions') return json(200, this.versions);
    if (method === 'POST' && path === '/api/versions') return this.upload(headers, user, body);
    const file = /^\/api\/versions\/(\d+)\/file$/.exec(path);
    if (method === 'GET' && file) return this.download(Number(file[1]), headers);
    const map = /^\/api\/versions\/(\d+)\/map$/.exec(path);
    if (map) {
      const id = Number(map[1]);
      if (method === 'PUT') {
        this.maps.set(id, JSON.parse(new TextDecoder().decode(body)));
        return json(204, null);
      }
      return this.maps.has(id) ? json(200, this.maps.get(id)) : err(404, 'map_not_found', 'Keine Karte.');
    }
    const restore = /^\/api\/versions\/(\d+)\/restore$/.exec(path);
    if (method === 'POST' && restore) {
      if (this.activeLease() !== null) return err(409, 'host_active', 'Gerade hostet jemand.');
      const src = this.versions.find((v) => v.id === Number(restore[1]));
      const data = src ? this.files.get(src.id) : undefined;
      if (!src || !data) return err(404, 'version_not_found', 'Version nicht gefunden.');
      const v = this.addVersion(data, src.playSeconds, src.buildVersion, src.sessionName, user, 'normal', this.headId, null);
      this.headId = v.id;
      return json(201, v);
    }
    if (method === 'PUT' && path === '/api/presence') {
      const req = JSON.parse(new TextDecoder().decode(body)) as { status: string };
      this.presence.set(user, { status: req.status, at: now });
      return json(204, null);
    }
    if (method === 'GET' && path === '/api/crew') {
      const names = new Set([...this.tokens.values()]);
      return json(
        200,
        [...names].map((name) => {
          const p = this.presence.get(name);
          const online = p !== undefined && now - p.at < 90_000;
          return {
            name,
            online,
            status: online ? p.status : null,
            lastSeen: p ? new Date(p.at).toISOString() : null,
            isHost: this.activeLease()?.user === name,
          };
        }),
      );
    }
    return err(404, 'not_found', 'Unbekannt.');
  }

  private upload(headers: Headers, user: string, body: Uint8Array): Response {
    const key = headers.get('Idempotency-Key') ?? '';
    const known = this.idempotency.get(`${user}:${key}`);
    if (known) return json(known.status, known.body);
    if (this.diskFull) return err(507, 'disk_full', 'Server-Festplatte voll.');
    if (headers.get('Content-SHA256') !== sha(body)) return err(400, 'hash_mismatch', 'Hash stimmt nicht.');
    let header;
    try {
      header = parseSaveHeader(body);
    } catch {
      return err(422, 'invalid_save', 'Kein gültiger Spielstand.');
    }
    if (this.sessionName !== null && header.sessionName !== this.sessionName) {
      return err(422, 'wrong_session', 'Falscher Spielstand.', { expected: this.sessionName, actual: header.sessionName });
    }
    const base = Number(headers.get('Base-Version') ?? '0');
    const tokenHeader = headers.get('Lease-Token');
    const head = this.head();
    let reason: Version['conflictReason'] = null;
    if (tokenHeader === null) reason = 'no_lease';
    else {
      const active = this.activeLease();
      if (this.lease === null || active === null) reason = 'lease_expired';
      else if (active.token !== Number(tokenHeader) || active.user !== user) reason = 'stale_token';
      else if ((this.headId ?? 0) !== base) reason = 'base_mismatch';
      else if (head !== null && header.playSeconds < head.playSeconds) reason = 'playtime_regressed';
    }
    let status: number;
    let result: unknown;
    if (reason === null) {
      const v = this.addVersion(body, header.playSeconds, header.buildVersion, header.sessionName, user, 'normal', base, null);
      this.headId = v.id;
      this.sessionName ??= header.sessionName;
      status = 201;
      result = { accepted: true, version: v, conflictReason: null, message: null };
    } else {
      const v = this.addVersion(body, header.playSeconds, header.buildVersion, header.sessionName, user, 'konflikt', base, reason);
      status = 409;
      result = { accepted: false, version: v, conflictReason: reason, message: `Als Konfliktkopie ${v.label} gespeichert.` };
    }
    this.idempotency.set(`${user}:${key}`, { status, body: result });
    return json(status, result);
  }

  private download(id: number, headers: Headers): Response {
    const v = this.versions.find((x) => x.id === id);
    let data = this.files.get(id);
    if (!v || !data) return err(404, 'version_not_found', 'Version nicht gefunden.');
    if (this.corruptDownloads) {
      data = new Uint8Array(data);
      data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
    }
    const common = { ETag: `"${v.sha256}"`, 'Content-SHA256': v.sha256, 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-$/.exec(headers.get('Range') ?? '');
    let status = 200;
    let slice = data;
    const extra: Record<string, string> = {};
    if (range) {
      const start = Number(range[1]);
      if (start >= data.length) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${data.length}` } });
      }
      status = 206;
      slice = data.slice(start);
      extra['Content-Range'] = `bytes ${start}-${data.length - 1}/${data.length}`;
    } else {
      extra['Content-Length'] = String(data.length);
    }
    const cut = this.cutNextDownloadAt;
    this.cutNextDownloadAt = null;
    let step = 0;
    const bodyStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        step++;
        if (cut !== null) {
          if (step === 1) controller.enqueue(slice.slice(0, cut));
          else controller.error(new Error('Verbindung abgebrochen'));
          return;
        }
        controller.enqueue(slice);
        controller.close();
      },
    });
    return new Response(bodyStream, { status, headers: { ...common, ...extra } });
  }
}
