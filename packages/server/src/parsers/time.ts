/**
 * Timestamp helpers for the parsers. Log timestamps come in three shapes:
 * RFC 3164 (`Oct 25 14:03:12`, no year and no zone), RFC 3339
 * (`2026-10-25T14:03:12.123456-05:00`) and the access-log format
 * (`25/Oct/2026:14:03:12 -0500`). Everything is converted to epoch milliseconds (UTC).
 */

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Month number (1–12) for an English three-letter abbreviation, or undefined. */
export function monthNumber(abbreviation: string): number | undefined {
  return MONTHS[abbreviation];
}

export interface WallTime {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** True when the fields form a real calendar date and time (leap years included). */
export function isValidWallTime(t: WallTime): boolean {
  if (t.month < 1 || t.month > 12 || t.day < 1) return false;
  if (t.hour > 23 || t.minute > 59 || t.second > 59) return false;
  const lastDay = new Date(Date.UTC(t.year, t.month, 0)).getUTCDate();
  return t.day <= lastDay;
}

function wallTimeAsUtc(t: WallTime): number {
  const ms = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second, t.millisecond);
  // Date.UTC maps years 0–99 to 1900–1999; logs never carry such years, but stay exact.
  if (t.year >= 0 && t.year < 100) {
    return new Date(ms).setUTCFullYear(t.year);
  }
  return ms;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/**
 * Offsets only change on quarter-hour boundaries in practice, so a small cache keyed by
 * zone and 15-minute slot keeps `Intl` out of the hot path when parsing large files.
 */
const OFFSET_SLOT_MS = 15 * 60 * 1000;
const MAX_CACHED_OFFSETS = 10_000;
const offsetCache = new Map<string, number>();

/** Offset of `zone` at the instant `utcMs`, in milliseconds (local wall time minus UTC). */
export function zoneOffsetMs(utcMs: number, zone: string): number {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 0;
  const key = `${zone}|${Math.floor(utcMs / OFFSET_SLOT_MS)}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;

  const parts = formatterFor(zone).formatToParts(new Date(utcMs));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const local = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  const offset = local - Math.floor(utcMs / 1000) * 1000;

  if (offsetCache.size >= MAX_CACHED_OFFSETS) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

/**
 * Convert a wall-clock time in an IANA zone to epoch milliseconds. Ambiguous times (the
 * repeated hour when DST ends) resolve to the first occurrence; non-existent times (the
 * skipped hour when DST starts) shift forward by the size of the gap.
 */
export function zonedTimeToUtc(t: WallTime, zone: string): number {
  const naive = wallTimeAsUtc(t);
  const firstGuess = naive - zoneOffsetMs(naive, zone);
  const secondOffset = zoneOffsetMs(firstGuess, zone);
  return naive - secondOffset;
}

const RFC3164_TIME = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * RFC 3164 timestamp (`Oct 25 14:03:12`, also `Oct  5 ...`). The year is `defaultYear`
 * (or `receivedAt`'s year in `zone`); a result more than 24 hours after `receivedAt` is
 * moved one year back, so December lines read in January land in the right year.
 */
export function parseRfc3164Time(
  text: string,
  zone: string,
  receivedAt: Date,
  defaultYear?: number,
): number | undefined {
  const m = RFC3164_TIME.exec(text);
  if (!m) return undefined;
  const month = monthNumber(m[1] ?? '');
  if (month === undefined) return undefined;
  const receivedMs = receivedAt.getTime();
  const year =
    defaultYear ?? new Date(receivedMs + zoneOffsetMs(receivedMs, zone)).getUTCFullYear();
  const base = {
    month,
    day: Number(m[2]),
    hour: Number(m[3]),
    minute: Number(m[4]),
    second: Number(m[5]),
    millisecond: 0,
  };
  const current = { ...base, year };
  if (isValidWallTime(current)) {
    const ms = zonedTimeToUtc(current, zone);
    if (ms - receivedMs <= DAY_MS) return ms;
  }
  // Year rollover (or Feb 29 that only exists in an earlier year's context).
  const previous = { ...base, year: year - 1 };
  if (!isValidWallTime(previous)) return undefined;
  return zonedTimeToUtc(previous, zone);
}

const RFC3339_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})?$/;

/**
 * RFC 3339 timestamp, optional fraction (kept to milliseconds), `Z` or `±hh:mm`. Without
 * an offset the wall time is read in `zone`. A leap second (`:60`) is read as `:59`.
 */
export function parseRfc3339Time(text: string, zone: string): number | undefined {
  const m = RFC3339_TIME.exec(text);
  if (!m) return undefined;
  const fraction = (m[7] ?? '').slice(0, 3).padEnd(3, '0');
  const t: WallTime = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Math.min(Number(m[6]), 59),
    millisecond: Number(fraction),
  };
  if (!isValidWallTime(t)) return undefined;
  const offset = m[8];
  if (offset === undefined) return zonedTimeToUtc(t, zone);
  if (offset === 'Z' || offset === 'z') return wallTimeAsUtc(t);
  const offsetMinutes = parseOffsetMinutes(offset);
  if (offsetMinutes === undefined) return undefined;
  return wallTimeAsUtc(t) - offsetMinutes * 60_000;
}

/** `+05:30` or `-0500` → signed minutes; undefined beyond ±18:00 or with minutes ≥ 60. */
function parseOffsetMinutes(offset: string): number | undefined {
  const sign = offset.startsWith('-') ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (minutes > 59 || hours * 60 + minutes > 18 * 60) return undefined;
  return sign * (hours * 60 + minutes);
}

const ACCESS_LOG_TIME = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/;

/** Access-log timestamp: `25/Oct/2026:14:03:12 -0500`. */
export function parseAccessLogTime(text: string): number | undefined {
  const m = ACCESS_LOG_TIME.exec(text);
  if (!m) return undefined;
  const month = monthNumber(m[2] ?? '');
  const offset = m[7] ?? '';
  if (month === undefined) return undefined;
  const offsetMinutes = parseOffsetMinutes(offset);
  if (offsetMinutes === undefined) return undefined;
  const t: WallTime = {
    year: Number(m[3]),
    month,
    day: Number(m[1]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Math.min(Number(m[6]), 59),
    millisecond: 0,
  };
  if (!isValidWallTime(t)) return undefined;
  return wallTimeAsUtc(t) - offsetMinutes * 60_000;
}
