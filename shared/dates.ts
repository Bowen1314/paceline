/**
 * Calendar-date helpers. Dates are `YYYY-MM-DD` strings and all arithmetic is
 * done in UTC so results never depend on the machine's time zone.
 */
import type { ISODate } from './contract.ts';

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toISO(t) === s;
}

function toMs(d: ISODate): number {
  const m = ISO_RE.exec(d);
  if (!m) throw new RangeError(`Not an ISO date: ${String(d)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function toISO(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC calendar date of an instant. */
export function dateOf(instant: Date | string): ISODate {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  return d.toISOString().slice(0, 10);
}

/**
 * The calendar date of an instant in an IANA time zone ("America/Los_Angeles").
 * PayPal reads `invoice_date` in the merchant's own time zone and SCHEDULES an
 * invoice dated "tomorrow" instead of sending it, so in the evening (US time)
 * the UTC date is the wrong "today" for anything that reaches PayPal.
 */
export function dateInZone(instant: Date, timeZone: string): ISODate {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** True if `timeZone` is an IANA zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function addDays(d: ISODate, n: number): ISODate {
  return toISO(toMs(d) + n * DAY_MS);
}

/** b - a in calendar days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

export function maxDate(...ds: ISODate[]): ISODate {
  return ds.reduce((a, b) => (a >= b ? a : b));
}

export function minDate(...ds: ISODate[]): ISODate {
  return ds.reduce((a, b) => (a <= b ? a : b));
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(d: ISODate): number {
  return new Date(toMs(d)).getUTCDay();
}

export function isWorkingDay(d: ISODate): boolean {
  const w = weekday(d);
  return w !== 0 && w !== 6;
}

/** `d` itself if it is a working day, otherwise the next one. */
export function rollForward(d: ISODate): ISODate {
  let cur = d;
  while (!isWorkingDay(cur)) cur = addDays(cur, 1);
  return cur;
}

/** The first working day strictly after `d`. */
export function nextWorkingDay(d: ISODate): ISODate {
  return rollForward(addDays(d, 1));
}

/**
 * Add `n` working days to a working day. `addWorkingDays(mon, 0) === mon`,
 * `addWorkingDays(fri, 1) === next mon`.
 */
export function addWorkingDays(d: ISODate, n: number): ISODate {
  let cur = rollForward(d);
  for (let i = 0; i < n; i++) cur = nextWorkingDay(cur);
  return cur;
}

/** Last working day of a task of `duration` working days starting on `start`. */
export function workEndFor(start: ISODate, durationDays: number): ISODate {
  return durationDays <= 0 ? start : addWorkingDays(start, durationDays - 1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** `Oct 14` — or `Oct 14, 2027` when `withYear`. Locale-independent on purpose. */
export function formatDate(d: ISODate, withYear = false): string {
  const m = ISO_RE.exec(d);
  if (!m) return d;
  const base = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  return withYear ? `${base}, ${m[1]}` : base;
}

export function formatWeekday(d: ISODate): string {
  return WEEKDAYS[weekday(d)] ?? '';
}
