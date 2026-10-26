/**
 * Time-range filter shared by every page. The URL holds either a preset (`range=7d`) or a
 * custom range (`from`/`to` as ISO 8601). Presets send only `from`, so the server's `to`
 * (now) keeps moving and live refreshes include new data; custom ranges send both.
 */
import type { Bucket } from '@centinela/shared';
import { z } from 'zod';

export const RANGE_PRESETS = ['1h', '24h', '7d', '30d'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_PRESET: RangePreset = '24h';

const HOUR = 60 * 60 * 1000;
export const PRESET_MS: Readonly<Record<RangePreset, number>> = {
  '1h': HOUR,
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
  '30d': 30 * 24 * HOUR,
};

export type TimeRange =
  | { kind: 'preset'; preset: RangePreset }
  | { kind: 'custom'; from: string; to: string | undefined };

const presetSchema = z.enum(RANGE_PRESETS);
const isoSchema = z.iso.datetime({ offset: true });

/** Reads the range from URL search params; invalid values fall back to the default preset. */
export function readTimeRange(params: URLSearchParams): TimeRange {
  const from = isoSchema.safeParse(params.get('from'));
  if (from.success) {
    const to = isoSchema.safeParse(params.get('to'));
    const toValue =
      to.success && Date.parse(to.data) >= Date.parse(from.data) ? to.data : undefined;
    return { kind: 'custom', from: from.data, to: toValue };
  }
  const preset = presetSchema.safeParse(params.get('range'));
  return { kind: 'preset', preset: preset.success ? preset.data : DEFAULT_PRESET };
}

/** Writes the range into a copy of the params (the default preset is left implicit). */
export function writeTimeRange(params: URLSearchParams, range: TimeRange): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('range');
  next.delete('from');
  next.delete('to');
  if (range.kind === 'custom') {
    next.set('from', range.from);
    if (range.to) next.set('to', range.to);
  } else if (range.preset !== DEFAULT_PRESET) {
    next.set('range', range.preset);
  }
  return next;
}

/** API `from`/`to` for a range. Preset starts are floored to the minute for stable query keys. */
export function rangeQuery(range: TimeRange, now = Date.now()): { from: string; to?: string } {
  if (range.kind === 'custom') {
    return range.to ? { from: range.from, to: range.to } : { from: range.from };
  }
  const minute = Math.floor(now / 60_000) * 60_000;
  return { from: new Date(minute - PRESET_MS[range.preset]).toISOString() };
}

/** Chart bucket for a range: about 12 to 30 points. */
export function bucketFor(range: TimeRange, now = Date.now()): Bucket {
  const span =
    range.kind === 'preset'
      ? PRESET_MS[range.preset]
      : (range.to ? Date.parse(range.to) : now) - Date.parse(range.from);
  if (span <= 3 * HOUR) return '5m';
  if (span <= 3 * 24 * HOUR) return '1h';
  return '1d';
}

export const BUCKET_MS: Readonly<Record<Bucket, number>> = {
  '5m': 5 * 60 * 1000,
  '1h': HOUR,
  '1d': 24 * HOUR,
};

/**
 * Fills a sparse `{ t, count }` series with zero buckets from `from` to `to`, aligned like
 * PostgreSQL `date_bin` (to the Unix epoch), so charts show quiet periods.
 */
export function fillBuckets(
  series: ReadonlyArray<{ t: string; count: number }>,
  from: string,
  to: string,
  bucket: Bucket,
): Array<{ t: string; count: number }> {
  const size = BUCKET_MS[bucket];
  const counts = new Map<number, number>();
  for (const point of series) {
    const key = Math.floor(Date.parse(point.t) / size) * size;
    counts.set(key, (counts.get(key) ?? 0) + point.count);
  }
  const start = Math.floor(Date.parse(from) / size) * size;
  const end = Math.floor(Date.parse(to) / size) * size;
  const filled: Array<{ t: string; count: number }> = [];
  // Guard against huge ranges: never more than 2,000 points.
  for (let t = start; t <= end && filled.length < 2000; t += size) {
    filled.push({ t: new Date(t).toISOString(), count: counts.get(t) ?? 0 });
  }
  return filled;
}

/** `<input type="datetime-local">` value (local time) for an ISO timestamp, and back. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
