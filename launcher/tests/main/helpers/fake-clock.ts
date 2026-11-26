/** Simulierte Uhr: Timer laufen nur bei `advance`. */
import type { Cancel, Clock } from '../../../src/main/ports';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Lässt laufende Promise-Ketten (simuliertes FS/Netz) zu Ende laufen. */
export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

export class FakeClock implements Clock {
  private timers: Timer[] = [];
  private seq = 0;

  constructor(private current = Date.UTC(2026, 10, 26, 19, 0, 0)) {}

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): Cancel {
    const timer = { id: ++this.seq, at: this.current + Math.max(0, ms), fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  pending(): number {
    return this.timers.length;
  }

  /** Zeit vorspulen; fällige Timer der Reihe nach ausführen, dazwischen Promises abarbeiten. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await settle();
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
      await settle();
    }
    this.current = target;
    await settle();
  }
}
