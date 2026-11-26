/**
 * Spiel starten (nur über Store-URIs) und Prozess-Wächter (Polling über `tasklist /FO CSV /NH`).
 */
import type { Platform } from '../../shared/ipc';
import {
  EPIC_DEFAULT_APP_NAME,
  epicLaunchUri,
  type EpicLaunchTarget,
  GAME_PROCESS_NAMES,
  PROCESS_GONE_GRACE_MS,
  PROCESS_POLL_MS,
  STEAM_LAUNCH_URI,
} from '../game-assumptions';
import { every, type Cancel, type Clock, type CommandRunner } from '../ports';

/** Start-URI; bei Epic für die installierte Version (AppName aus dem Manifest). */
export function launchUriFor(platform: Platform, epic?: EpicLaunchTarget | null): string {
  return platform === 'steam'
    ? STEAM_LAUNCH_URI
    : epicLaunchUri(epic ?? { appName: EPIC_DEFAULT_APP_NAME });
}

/** Erste Spalte jeder CSV-Zeile von `tasklist /FO CSV /NH` (Abbildname). */
export function parseTasklistCsv(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"([^"]*)"/.exec(line.trim());
    if (match?.[1] !== undefined && match[1] !== '') names.push(match[1]);
  }
  return names;
}

/** Läuft Satisfactory (egal ob Steam- oder Epic-Build)? */
export function isGameProcess(name: string): boolean {
  const lower = name.toLowerCase();
  return Object.values(GAME_PROCESS_NAMES).some((n) => n.toLowerCase() === lower);
}

export type ProcessProbe = () => Promise<boolean>;

export function tasklistProbe(run: CommandRunner): ProcessProbe {
  return async () => {
    const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
    return parseTasklistCsv(out).some(isGameProcess);
  };
}

/**
 * Meldet Start und Ende des Spiels. Ende erst, wenn der Prozess `PROCESS_GONE_GRACE_MS` am Stück
 * fehlt (Steam startet eventuell neu). Fehler beim Abfragen ändern den Zustand nicht.
 */
export class GameProcessWatcher {
  private running = false;
  private goneSince: number | null = null;
  private cancel: Cancel | null = null;
  private readonly listeners = new Set<(running: boolean) => void>();

  constructor(
    private readonly probe: ProcessProbe,
    private readonly clock: Clock,
    private readonly pollMs = PROCESS_POLL_MS,
    private readonly graceMs = PROCESS_GONE_GRACE_MS,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  onChange(listener: (running: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Einmal sofort prüfen (ohne Gnadenfrist beim ersten Mal), dann regelmäßig. */
  async start(): Promise<boolean> {
    try {
      this.running = await this.probe();
    } catch {
      this.running = false;
    }
    this.cancel ??= every(this.clock, this.pollMs, () => this.poll());
    return this.running;
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  async poll(): Promise<void> {
    let seen: boolean;
    try {
      seen = await this.probe();
    } catch {
      return;
    }
    if (seen) {
      this.goneSince = null;
      if (!this.running) this.set(true);
      return;
    }
    if (!this.running) return;
    const now = this.clock.now();
    this.goneSince ??= now;
    if (now - this.goneSince >= this.graceMs) {
      this.goneSince = null;
      this.set(false);
    }
  }

  private set(running: boolean): void {
    this.running = running;
    for (const l of this.listeners) l(running);
  }
}
