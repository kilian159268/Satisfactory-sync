/** Einstellungen als JSON in userData (`settings.json`), atomar geschrieben, mit Zod geprüft. */
import { join } from 'node:path';
import { DEFAULT_SERVER_URL } from '../../shared/api-types';
import { SettingsSchema, type Settings, type SettingsPatch } from '../../shared/ipc';
import { readJson, writeJsonAtomic } from '../files';
import type { FileSystem } from '../ports';

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  platform: null,
  saveDir: null,
  autostart: false,
};

export class SettingsStore {
  private readonly path: string;
  private current: Settings = DEFAULT_SETTINGS;

  constructor(
    private readonly fs: FileSystem,
    userDataDir: string,
  ) {
    this.path = join(userDataDir, 'settings.json');
  }

  async load(): Promise<Settings> {
    const raw = await readJson(this.fs, this.path);
    if (raw !== null && typeof raw === 'object') {
      // Einzelne kaputte Felder fallen auf den Standard zurück, der Rest bleibt.
      const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const value = (raw as Record<string, unknown>)[key];
        const single = SettingsSchema.shape[key].safeParse(value);
        if (single.success) merged[key] = single.data;
      }
      this.current = SettingsSchema.parse(merged);
    } else {
      this.current = DEFAULT_SETTINGS;
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const next = SettingsSchema.parse({ ...this.current, ...patch });
    await writeJsonAtomic(this.fs, this.path, next);
    this.current = next;
    return next;
  }
}
