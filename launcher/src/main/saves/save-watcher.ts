/**
 * Save-Watcher (Plan 4.4): beobachtet den Save-Ordner per Polling. Eine .sav-Datei wird nur
 * gemeldet, wenn
 *  - sie sich `SAVE_QUIET_MS` lang nicht verändert hat (Spiel ist fertig mit Schreiben),
 *  - der Header lesbar ist und der Sessionname passt,
 *  - die Spielzeit ≥ der zuletzt hochgeladenen ist.
 * Jeder Dateistand (Größe + Änderungszeit) wird höchstens einmal geprüft.
 */
import { join } from 'node:path';
import { SAVE_POLL_MS, SAVE_QUIET_MS } from '../game-assumptions';
import { every, type Cancel, type Clock, type FileSystem } from '../ports';
import { isSaveFile, type SessionSave } from './save-files';
import { tryReadSaveHeader, type SaveHeader } from './save-header';

export interface WatchRules {
  /** Sessionname des gemeinsamen Stands; null = noch keiner (erste Session überhaupt). */
  sessionName: string | null;
  /** Spielzeit des zuletzt hochgeladenen Stands. */
  minPlaySeconds: number;
  /** Ohne Sessionnamen zählen nur Dateien, die nach diesem Zeitpunkt geschrieben wurden. */
  notBeforeMs: number;
}

export type Verdict = 'ok' | 'wrong_session' | 'playtime_regressed' | 'too_old';

export function judgeSave(header: SaveHeader, mtimeMs: number, rules: WatchRules): Verdict {
  if (rules.sessionName !== null) {
    if (header.sessionName !== rules.sessionName) return 'wrong_session';
  } else if (mtimeMs < rules.notBeforeMs) {
    return 'too_old';
  }
  if (header.playSeconds < rules.minPlaySeconds) return 'playtime_regressed';
  return 'ok';
}

interface Track {
  signature: string;
  changedAt: number;
  handled: boolean;
}

export class SaveWatcher {
  private readonly tracks = new Map<string, Track>();
  private cancel: Cancel | null = null;
  private ticking = false;

  constructor(
    private readonly fs: FileSystem,
    private readonly clock: Clock,
    private readonly saveDir: string,
    private readonly rules: () => WatchRules,
    private readonly onSave: (save: SessionSave) => Promise<void> | void,
    private readonly onRejected?: (save: SessionSave, verdict: Verdict) => void,
    private readonly quietMs = SAVE_QUIET_MS,
    private readonly pollMs = SAVE_POLL_MS,
  ) {}

  start(): void {
    this.cancel ??= every(this.clock, this.pollMs, () => this.tick());
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** Ein Durchlauf (öffentlich für Tests). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      const seen = new Set<string>();
      for (const name of await this.fs.readdir(this.saveDir)) {
        if (!isSaveFile(name)) continue;
        const path = join(this.saveDir, name);
        const stat = await this.fs.stat(path);
        if (stat?.isFile !== true) continue;
        seen.add(path);
        const signature = `${stat.size}:${stat.mtimeMs}`;
        const track = this.tracks.get(path);
        if (track?.signature !== signature) {
          this.tracks.set(path, { signature, changedAt: now, handled: false });
          continue;
        }
        if (track.handled || now - track.changedAt < this.quietMs) continue;
        track.handled = true;
        const header = await tryReadSaveHeader(this.fs, path);
        if (header === null) continue; // unlesbar: ignorieren (wird bei Änderung neu geprüft)
        const save: SessionSave = { path, name, size: stat.size, mtimeMs: stat.mtimeMs, header };
        const verdict = judgeSave(header, stat.mtimeMs, this.rules());
        if (verdict === 'ok') await this.onSave(save);
        else this.onRejected?.(save, verdict);
      }
      for (const path of [...this.tracks.keys()]) {
        if (!seen.has(path)) this.tracks.delete(path);
      }
    } finally {
      this.ticking = false;
    }
  }
}
