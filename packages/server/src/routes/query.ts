/** Helpers shared by the list endpoints, applied after the shared zod schemas. */
import { ipAddressSchema } from '@centinela/shared';
import { decodeCursor, type KeysetPosition } from '../db/cursor.js';
import type { TimeRange } from '../db/events-read.js';
import { HttpError } from '../http/problem.js';

export const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

/**
 * `from`/`to` with the API defaults (ARCHITECTURE §9, S3-03): `to` is now whenever it is
 * absent, also when `from` is given; `from` is `to` minus 24 hours. A `from` in the future
 * without a `to` gives an empty range rather than an error.
 */
export function resolveTimeRange(
  query: { from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): TimeRange {
  const to = query.to === undefined ? now : new Date(query.to);
  const from =
    query.from === undefined ? new Date(to.getTime() - DEFAULT_RANGE_MS) : new Date(query.from);
  return { from, to };
}

export function invalidQuery(path: string, message: string): HttpError {
  return new HttpError(400, 'Invalid query', [{ path, message }]);
}

/** The keyset position in `cursor`, or a `400` when the server did not produce it. */
export function parseCursor(cursor: string | undefined): KeysetPosition | undefined {
  if (cursor === undefined) return undefined;
  const position = decodeCursor(cursor);
  if (!position) throw invalidQuery('cursor', 'invalid cursor');
  return position;
}

/** `ip` filters must be IP addresses (they are compared with `inet` values). */
export function checkIp(ip: string | undefined): string | undefined {
  if (ip !== undefined && !ipAddressSchema.safeParse(ip).success) {
    throw invalidQuery('ip', 'must be an IPv4 or IPv6 address');
  }
  return ip;
}
