/**
 * Formatierer für die Oberfläche (deutsch, kurz). Rein, ohne React; `now` wird übergeben,
 * damit alles testbar ist. Zeiten werden in der lokalen Zeitzone dargestellt.
 */

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toDate(value: string | Date): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Ganze Zahl mit deutschem Tausenderpunkt: 1412 → „1.412“. */
export function formatInteger(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return value < 0 ? `-${grouped}` : grouped;
}

/** Spielzeit: 1_484_280 s → „412 h 18 min“; unter einer Stunde „18 min“. */
export function formatPlaytime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  if (hours === 0) return `${minutes} min`;
  return `${formatInteger(hours)} h ${minutes} min`;
}

/** Uhrzeit „19:42“. */
export function formatClock(value: string | Date): string {
  const date = toDate(value);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Kalendertage zwischen zwei Zeitpunkten (lokal, sommerzeitfest). */
function dayDiff(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / (DAY * 1000));
}

/**
 * Zeitpunkt relativ zum Tag: „heute, 19:42“, „gestern, 23:10“, „Mo, 21:05“ (letzte Woche),
 * „12.11., 21:05“ (dieses Jahr), sonst „12.11.2025“. Zukunft: „morgen, 22:14“ bzw. Datum.
 */
export function formatDayTime(value: string | Date, now: Date): string {
  const date = toDate(value);
  const clock = formatClock(date);
  const diff = dayDiff(date, now);
  if (diff === 0) return `heute, ${clock}`;
  if (diff === -1) return `morgen, ${clock}`;
  if (diff < -1) return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}., ${clock}`;
  if (diff === 1) return `gestern, ${clock}`;
  if (diff < 7) return `${WEEKDAYS[date.getDay()] ?? ''}, ${clock}`;
  const dayMonth = `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.`;
  if (date.getFullYear() === now.getFullYear()) return `${dayMonth}, ${clock}`;
  return `${dayMonth}${date.getFullYear()}`;
}

/** Dauer kurz: „1 Min.“, „3 Std.“, „2 Tagen“ – für „vor …“. Unter einer Minute: null. */
export function formatDurationAgo(seconds: number): string | null {
  const total = Math.max(0, Math.floor(seconds));
  if (total < MINUTE) return null;
  if (total < HOUR) return `${Math.floor(total / MINUTE)} Min.`;
  if (total < DAY) return `${Math.floor(total / HOUR)} Std.`;
  const days = Math.floor(total / DAY);
  return days === 1 ? '1 Tag' : `${days} Tagen`;
}

/** „vor 3 Std.“ bzw. „gerade eben“. */
export function formatAgoSeconds(seconds: number): string {
  const duration = formatDurationAgo(seconds);
  return duration === null ? 'gerade eben' : `vor ${duration}`;
}

/** „vor 3 Std.“ bzw. „gerade eben“ für einen Zeitpunkt. */
export function formatAgo(value: string | Date, now: Date): string {
  const seconds = (now.getTime() - toDate(value).getTime()) / 1000;
  return formatAgoSeconds(seconds);
}

/** Gruppe: „zuletzt vor 3 Std.“; ohne Zeitpunkt „offline“. */
export function formatLastSeen(value: string | null, now: Date): string {
  if (value === null) return 'offline';
  return `zuletzt ${formatAgo(value, now)}`;
}

/** „seit 20:14“ bzw. „seit gestern, 20:14“. */
export function formatSince(value: string | Date, now: Date): string {
  const date = toDate(value);
  const diff = dayDiff(date, now);
  return diff <= 0 ? `seit ${formatClock(date)}` : `seit ${formatDayTime(date, now)}`;
}

/** Antwortzeit „24 ms“. */
export function formatLatency(ms: number): string {
  return `${Math.round(ms)} ms`;
}

/** Kürzel für Avatare: „Testspieler A“ → „TA“, „Testspieler“ → „T“. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.map((word) => Array.from(word)[0] ?? '').filter(Boolean);
  if (letters.length === 0) return '?';
  const first = letters[0] ?? '';
  const last = letters.length > 1 ? (letters[letters.length - 1] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Aufzählung: [a] → „a“, [a, b] → „a und b“, [a, b, c] → „a, b und c“. */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1] ?? ''}`;
}
