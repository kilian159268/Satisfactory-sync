import { describe, expect, it } from 'vitest';
import {
  EVENTS,
  InvalidTransitionError,
  SESSION_PHASES,
  TRANSITIONS,
  nextPhase,
  recoveryFor,
  transition,
} from '../../src/main/sync/state-machine';
import { PHASES, type Phase } from '../../src/shared/ipc';

const entries = Object.entries(TRANSITIONS).flatMap(([from, events]) =>
  Object.entries(events).map(([event, to]) => ({ from: from as Phase, event, to })),
);

describe('Zustandsmaschine (Plan 6.1)', () => {
  it('hat für jede Phase aus ipc.ts eine Zeile', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...PHASES].sort());
  });

  it.each(entries)('$from --$event--> $to', ({ from, event, to }) => {
    expect(transition(from, event as (typeof EVENTS)[number])).toBe(to);
  });

  it('jede Phase ist erreichbar und jede Zielphase existiert', () => {
    const targets = new Set(entries.map((e) => e.to));
    for (const p of PHASES)
      if (p !== 'verbinden' && p !== 'fehler') expect(targets.has(p)).toBe(true);
    for (const t of targets) expect(PHASES).toContain(t);
  });

  it('FAIL führt aus jeder Phase nach fehler', () => {
    for (const p of PHASES) expect(transition(p, 'FAIL')).toBe('fehler');
  });

  it('nicht vorgesehene Ereignisse werfen InvalidTransitionError', () => {
    let invalid = 0;
    for (const p of PHASES) {
      for (const e of EVENTS) {
        if (e === 'FAIL' || TRANSITIONS[p][e] !== undefined) continue;
        expect(nextPhase(p, e)).toBeNull();
        expect(() => transition(p, e)).toThrow(InvalidTransitionError);
        invalid++;
      }
    }
    expect(invalid).toBeGreaterThan(100);
  });

  it('Hauptpfad aus dem Plan-Diagramm', () => {
    const path: [string, Phase][] = [
      ['PLAY', 'lease_holen'],
      ['LEASE_GRANTED', 'herunterladen'],
      ['DOWNLOADED', 'vorbereiten'],
      ['PREPARED', 'spiel_starten'],
      ['GAME_STARTED', 'hosten'],
      ['GAME_ENDED', 'beenden'],
      ['UPLOAD', 'hochladen'],
      ['UPLOADED', 'lease_freigeben'],
      ['RELEASED', 'aufraeumen'],
      ['CLEANED', 'bereit'],
    ];
    let p: Phase = 'bereit';
    for (const [e, to] of path) {
      p = transition(p, e as (typeof EVENTS)[number]);
      expect(p).toBe(to);
    }
  });

  it('Abschluss ohne Netz → wartet_auf_netz → RETRY → beenden', () => {
    expect(transition('hochladen', 'NETWORK_DOWN')).toBe('wartet_auf_netz');
    expect(transition('wartet_auf_netz', 'RETRY')).toBe('beenden');
    expect(transition('lease_holen', 'LEASE_HELD')).toBe('mitspieler');
    expect(transition('mitspieler', 'GAME_ENDED')).toBe('bereit');
  });

  describe('Recovery je Journal-Phase', () => {
    const expected: Record<string, [string, string]> = {
      lease_holen: ['DISCARD', 'DISCARD'],
      herunterladen: ['RECOVER_RELEASE', 'RECOVER_RELEASE'],
      vorbereiten: ['RECOVER_FINISH', 'RECOVER_HOSTING'],
      spiel_starten: ['RECOVER_FINISH', 'RECOVER_HOSTING'],
      hosten: ['RECOVER_FINISH', 'RECOVER_HOSTING'],
      beenden: ['RECOVER_FINISH', 'RECOVER_HOSTING'],
      hochladen: ['RECOVER_FINISH', 'RECOVER_HOSTING'],
      wartet_auf_netz: ['RECOVER_FINISH', 'RECOVER_HOSTING'],
      lease_freigeben: ['RECOVER_RELEASE', 'RECOVER_RELEASE'],
      aufraeumen: ['RECOVER_CLEANUP', 'RECOVER_CLEANUP'],
    };
    it('deckt genau die Session-Phasen ab', () => {
      expect(Object.keys(expected).sort()).toEqual([...SESSION_PHASES].sort());
    });
    it.each(Object.entries(expected))('%s', (phase, [off, on]) => {
      expect(recoveryFor(phase as Phase, false)).toBe(off);
      expect(recoveryFor(phase as Phase, true)).toBe(on);
      for (const ev of [off, on])
        if (ev !== 'DISCARD')
          expect(nextPhase('verbinden', ev as (typeof EVENTS)[number])).not.toBeNull();
    });
    it('Phasen ohne Session werden verworfen', () => {
      for (const p of PHASES.filter((x) => !SESSION_PHASES.has(x)))
        expect(recoveryFor(p, true)).toBe('DISCARD');
    });
  });
});
