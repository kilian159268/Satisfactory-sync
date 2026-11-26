import { describe, expect, it } from 'vitest';
import { StubBackend } from '../../src/main/stub-backend';
import {
  AppStateSchema,
  MapDataSchema,
  SettingsSchema,
  VersionViewSchema,
  type AppState,
} from '../../src/shared/ipc';

describe('StubBackend', () => {
  it('liefert nur schema-gültige Daten', async () => {
    const backend = new StubBackend({ stepMs: 0 });
    expect(AppStateSchema.safeParse(await backend.getState()).success).toBe(true);
    const versions = await backend.listVersions();
    expect(versions.every((v) => VersionViewSchema.safeParse(v).success)).toBe(true);
    expect(SettingsSchema.safeParse(await backend.getSettings()).success).toBe(true);
    const first = versions[0];
    expect(first).toBeDefined();
    if (first) expect(MapDataSchema.safeParse(await backend.getMap(first.id)).success).toBe(true);
    await backend.dispose();
  });

  it('durchläuft beim Spielen die Phasen bis „hosten“ mit gültigen Zuständen', async () => {
    const backend = new StubBackend({ stepMs: 1 });
    const seen: AppState[] = [];
    backend.onStateChange((s) => seen.push(s));
    await backend.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(await backend.play()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((s) => s.phase)).toContain('herunterladen');
    expect(seen.at(-1)?.phase).toBe('hosten');
    expect(seen.every((s) => AppStateSchema.safeParse(s).success)).toBe(true);
    await backend.dispose();
  });
});
