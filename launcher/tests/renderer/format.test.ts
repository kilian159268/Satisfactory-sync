import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatAgoSeconds,
  formatDayTime,
  formatInteger,
  formatLastSeen,
  formatLatency,
  formatPlaytime,
  formatSince,
  initials,
  joinList,
} from '../../src/renderer/lib/format';

// Lokale Zeiten, damit die Tests in jeder Zeitzone gleich laufen. 26.11.2026 ist ein Donnerstag.
const NOW = new Date(2026, 10, 26, 20, 30);

describe('formatPlaytime', () => {
  it('Stunden und Minuten', () => {
    expect(formatPlaytime(412 * 3600 + 18 * 60 + 59)).toBe('412 h 18 min');
  });
  it('unter einer Stunde nur Minuten', () => {
    expect(formatPlaytime(18 * 60)).toBe('18 min');
    expect(formatPlaytime(0)).toBe('0 min');
  });
  it('Tausenderpunkt', () => {
    expect(formatPlaytime(1412 * 3600)).toBe('1.412 h 0 min');
  });
  it('negative Werte werden zu 0', () => {
    expect(formatPlaytime(-5)).toBe('0 min');
  });
});

describe('formatDayTime', () => {
  it('Zukunft: morgen bzw. Datum (z. B. Ablauf eines Codes)', () => {
    expect(formatDayTime(new Date(2026, 10, 27, 22, 14), NOW)).toBe('morgen, 22:14');
    expect(formatDayTime(new Date(2026, 10, 29, 8, 5), NOW)).toBe('29.11., 08:05');
  });

  it('heute', () => {
    expect(formatDayTime(new Date(2026, 10, 26, 19, 42), NOW)).toBe('heute, 19:42');
  });
  it('gestern', () => {
    expect(formatDayTime(new Date(2026, 10, 25, 23, 10), NOW)).toBe('gestern, 23:10');
  });
  it('Wochentag innerhalb der letzten Woche', () => {
    expect(formatDayTime(new Date(2026, 10, 23, 21, 5), NOW)).toBe('Mo, 21:05');
    expect(formatDayTime(new Date(2026, 10, 20, 8, 0), NOW)).toBe('Fr, 08:00');
  });
  it('älter: Datum', () => {
    expect(formatDayTime(new Date(2026, 10, 12, 21, 5), NOW)).toBe('12.11., 21:05');
    expect(formatDayTime(new Date(2025, 0, 3, 21, 5), NOW)).toBe('03.01.2025');
  });
  it('nimmt ISO-Strings', () => {
    expect(formatDayTime(new Date(2026, 10, 26, 7, 3).toISOString(), NOW)).toBe('heute, 07:03');
  });
  it('Zeitpunkt in der Zukunft (Uhrabweichung) gilt als heute', () => {
    expect(formatDayTime(new Date(2026, 10, 26, 20, 31), NOW)).toBe('heute, 20:31');
  });
});

describe('relative Zeiten', () => {
  it('formatAgoSeconds', () => {
    expect(formatAgoSeconds(10)).toBe('gerade eben');
    expect(formatAgoSeconds(60)).toBe('vor 1 Min.');
    expect(formatAgoSeconds(59 * 60)).toBe('vor 59 Min.');
    expect(formatAgoSeconds(3 * 3600 + 5)).toBe('vor 3 Std.');
    expect(formatAgoSeconds(86400)).toBe('vor 1 Tag');
    expect(formatAgoSeconds(3 * 86400)).toBe('vor 3 Tagen');
  });
  it('formatAgo', () => {
    expect(formatAgo(new Date(NOW.getTime() - 12 * 60_000), NOW)).toBe('vor 12 Min.');
  });
  it('formatLastSeen', () => {
    expect(formatLastSeen(new Date(NOW.getTime() - 3 * 3600_000).toISOString(), NOW)).toBe(
      'zuletzt vor 3 Std.',
    );
    expect(formatLastSeen(null, NOW)).toBe('offline');
  });
  it('formatSince', () => {
    expect(formatSince(new Date(2026, 10, 26, 20, 14), NOW)).toBe('seit 20:14');
    expect(formatSince(new Date(2026, 10, 25, 23, 50), NOW)).toBe('seit gestern, 23:50');
  });
});

describe('Kleinkram', () => {
  it('formatLatency', () => {
    expect(formatLatency(23.6)).toBe('24 ms');
  });
  it('formatInteger', () => {
    expect(formatInteger(1234567)).toBe('1.234.567');
    expect(formatInteger(12)).toBe('12');
  });
  it('initials', () => {
    expect(initials('Testspieler A')).toBe('TA');
    expect(initials('testspieler')).toBe('T');
    expect(initials('  ')).toBe('?');
    expect(initials('Ölfeld Ost Süd')).toBe('ÖS');
  });
  it('joinList', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['Konstruktor'])).toBe('Konstruktor');
    expect(joinList(['Konstruktor', 'Fertiger'])).toBe('Konstruktor und Fertiger');
    expect(joinList(['A1', 'B2', 'C3'])).toBe('A1, B2 und C3');
  });
});
