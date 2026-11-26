import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, HashMismatchError, isRetryable, NetworkError, ProtocolError } from '../../src/main/api/api-client';
import type { FetchFn } from '../../src/main/ports';
import { FakeClock } from './helpers/fake-clock';
import { FakeServer } from './helpers/fake-server';
import { MemoryFs } from './helpers/memory-fs';
import { buildSave } from './helpers/saves';

const sha = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');

function setup() {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  const token = server.addUser('Anna');
  const latencies: number[] = [];
  const api = new ApiClient({ baseUrl: 'https://sync.test/', token, fetch: server.fetch, clock, onLatency: (ms) => latencies.push(ms) });
  return { clock, server, api, latencies, fs: new MemoryFs() };
}

describe('API-Client', () => {
  it('schickt das Bearer-Token und prüft Antworten mit Zod', async () => {
    const { api, server, latencies } = setup();
    expect(await api.me()).toEqual({ name: 'Anna' });
    expect(server.log[0]?.headers.get('Authorization')).toBe('Bearer token-Anna');
    expect(server.log[0]?.path).toBe('/api/me');
    expect(latencies).toHaveLength(1);
    const bad = new ApiClient({ baseUrl: 'https://x', fetch: () => Promise.resolve(new Response('{"name":5}')), clock: new FakeClock() });
    await expect(bad.me()).rejects.toBeInstanceOf(ProtocolError);
    const notJson = new ApiClient({ baseUrl: 'https://x', fetch: () => Promise.resolve(new Response('<html>')), clock: new FakeClock() });
    await expect(notJson.me()).rejects.toBeInstanceOf(ProtocolError);
  });

  it('Fehlerformat → ApiError mit Code und deutscher Meldung; ohne JSON → http_<status>', async () => {
    const { api, server } = setup();
    server.tokens.clear();
    await expect(api.world()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    const plain = new ApiClient({ baseUrl: 'https://x', fetch: () => Promise.resolve(new Response('x', { status: 502 })), clock: new FakeClock() });
    const e = await plain.world().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'http_502' });
    expect(isRetryable(e)).toBe(true);
    expect(isRetryable(new ApiError(507, 'disk_full', 'x'))).toBe(false);
    expect(isRetryable(new ApiError(429, 'rate_limited', 'x'))).toBe(true);
    expect(isRetryable(new ApiError(403, 'not_uploader', 'x'))).toBe(false);
  });

  it('Netzfehler und Timeout → NetworkError', async () => {
    const clock = new FakeClock();
    const offline: FetchFn = () => Promise.reject(new TypeError('fetch failed'));
    await expect(new ApiClient({ baseUrl: 'https://x', fetch: offline, clock }).me()).rejects.toBeInstanceOf(NetworkError);
    const hanging: FetchFn = (_u, init) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
      });
    const api = new ApiClient({ baseUrl: 'https://x', fetch: hanging, clock, timeoutMs: 5_000 });
    const p = api.me().catch((e: unknown) => e);
    await clock.advance(5_000);
    const e = await p;
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as NetworkError).timedOut).toBe(true);
  });

  it('Lease: erteilt oder belegt (details = Host)', async () => {
    const { api, server } = setup();
    const r1 = await api.acquireLease();
    expect(r1.kind).toBe('granted');
    server.lease = { ...server.lease!, user: 'Max' };
    const r2 = await api.acquireLease();
    expect(r2).toMatchObject({ kind: 'held', host: { name: 'Max' } });
  });

  it('Upload als Stream mit allen Headern; 201 und 409 liefern UploadResult', async () => {
    const { api, server, fs } = setup();
    const data = buildSave({ sessionName: 'S', playSeconds: 10 });
    fs.put('/s/a.sav', data);
    const grant = await api.acquireLease();
    if (grant.kind !== 'granted') throw new Error();
    const req = { fs, path: '/s/a.sav', sha256: sha(data), idempotencyKey: 'k1', baseVersionId: 0, leaseToken: grant.grant.fencingToken };
    const r = await api.upload(req);
    expect(r.accepted).toBe(true);
    const h = server.log.at(-1)!.headers;
    expect(h.get('Lease-Token')).toBe(String(grant.grant.fencingToken));
    expect(h.get('Base-Version')).toBe('0');
    expect(h.get('Content-SHA256')).toBe(sha(data));
    expect(h.get('Idempotency-Key')).toBe('k1');
    expect(h.get('Content-Type')).toBe('application/octet-stream');
    // ohne Lease → Konfliktkopie (409), Lease-Token-Header fehlt
    const r2 = await api.upload({ ...req, idempotencyKey: 'k2', leaseToken: null });
    expect(r2).toMatchObject({ accepted: false, conflictReason: 'no_lease' });
    expect(server.log.at(-1)!.headers.has('Lease-Token')).toBe(false);
    // gleicher Key → gleiche Antwort, keine neue Version
    const count = server.versions.length;
    expect(await api.upload(req)).toEqual(r);
    expect(server.versions.length).toBe(count);
  });

  it('Upload-Fehler: hash_mismatch, disk_full als ApiError', async () => {
    const { api, server, fs } = setup();
    fs.put('/s/a.sav', buildSave({ sessionName: 'S', playSeconds: 1 }));
    await expect(api.upload({ fs, path: '/s/a.sav', sha256: '0'.repeat(64), idempotencyKey: 'k', baseVersionId: 0, leaseToken: null })).rejects.toMatchObject({ status: 400, code: 'hash_mismatch' });
    server.diskFull = true;
    await expect(api.upload({ fs, path: '/s/a.sav', sha256: '0'.repeat(64), idempotencyKey: 'k', baseVersionId: 0, leaseToken: null })).rejects.toMatchObject({ status: 507, code: 'disk_full' });
  });

  it('Download mit SHA-256-Prüfung; falscher Hash löscht die Teildatei', async () => {
    const { api, server, fs } = setup();
    const v = server.seedVersion(buildSave({ sessionName: 'S', playSeconds: 5, body: 'x'.repeat(10_000) }));
    await fs.mkdir('/c');
    const progress: number[] = [];
    await api.download({ fs, versionId: v.id, expectedSha256: v.sha256, partPath: '/c/1.part', onProgress: (r) => progress.push(r) });
    expect(sha(fs.get('/c/1.part')!)).toBe(v.sha256);
    expect(progress.at(-1)).toBe(v.size);
    server.corruptDownloads = true;
    const e = await api.download({ fs, versionId: v.id, expectedSha256: v.sha256, partPath: '/c/2.part' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HashMismatchError);
    expect(fs.has('/c/2.part')).toBe(false);
  });

  it('Download setzt nach Abbruch per Range fort (206), 416 bei vollständiger Teildatei', async () => {
    const { api, server, fs } = setup();
    const v = server.seedVersion(buildSave({ sessionName: 'S', playSeconds: 5, body: 'y'.repeat(50_000) }));
    await fs.mkdir('/c');
    server.cutNextDownloadAt = 20_000;
    await expect(api.download({ fs, versionId: v.id, expectedSha256: v.sha256, partPath: '/c/p' })).rejects.toBeInstanceOf(NetworkError);
    expect(fs.get('/c/p')?.length).toBe(20_000);
    await api.download({ fs, versionId: v.id, expectedSha256: v.sha256, partPath: '/c/p' });
    const last = server.log.at(-1)!.headers;
    expect(last.get('Range')).toBe('bytes=20000-');
    expect(last.get('If-Range')).toBe(`"${v.sha256}"`);
    expect(sha(fs.get('/c/p')!)).toBe(v.sha256);
    await api.download({ fs, versionId: v.id, expectedSha256: v.sha256, partPath: '/c/p' });
    expect(sha(fs.get('/c/p')!)).toBe(v.sha256);
  });

  it('Download: angekündigter Content-SHA256 passt nicht → sofort Abbruch', async () => {
    const fs = new MemoryFs();
    await fs.mkdir('/c');
    const fetchFn: FetchFn = () => Promise.resolve(new Response('abc', { status: 200, headers: { 'Content-SHA256': 'f'.repeat(64) } }));
    const api = new ApiClient({ baseUrl: 'https://x', fetch: fetchFn, clock: new FakeClock() });
    await expect(api.download({ fs, versionId: 1, expectedSha256: 'a'.repeat(64), partPath: '/c/x' })).rejects.toBeInstanceOf(HashMismatchError);
    expect(fs.has('/c/x')).toBe(false);
  });

  it('Karte: 404 → null; Presence/Crew/Versions', async () => {
    const { api, server } = setup();
    const v = server.seedVersion(buildSave({ sessionName: 'S', playSeconds: 5 }));
    expect(await api.getMap(v.id)).toBeNull();
    const map = { version: 1, clusters: [], stations: [], players: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
    await api.putMap(v.id, map);
    expect(await api.getMap(v.id)).toEqual(map);
    await api.presence('im_spiel');
    expect((await api.crew())[0]).toMatchObject({ name: 'Anna', status: 'im_spiel', online: true });
    expect((await api.versions())[0]?.id).toBe(v.id);
    expect((await api.health()).status).toBe('ok');
  });
});
