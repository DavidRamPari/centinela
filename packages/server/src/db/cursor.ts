/**
 * Keyset pagination cursors (ARCHITECTURE §9): base64url of `ts|id`, where `ts` is the
 * sort timestamp of the last item on the page (ISO 8601, UTC) and `id` its UUID. The next
 * page continues strictly after `(ts, id)` in descending order, so rows inserted while a
 * client pages never shift or duplicate the rows it has not seen yet.
 */
import { z } from 'zod';

export interface KeysetPosition {
  ts: string;
  id: string;
}

const positionSchema = z.object({ ts: z.iso.datetime(), id: z.uuid() });

export function encodeCursor(position: KeysetPosition): string {
  return Buffer.from(`${position.ts}|${position.id}`, 'utf8').toString('base64url');
}

/** The position in a cursor, or undefined when the cursor was not produced by the server. */
export function decodeCursor(cursor: string): KeysetPosition | undefined {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = text.indexOf('|');
  if (separator === -1) return undefined;
  const parsed = positionSchema.safeParse({
    ts: text.slice(0, separator),
    id: text.slice(separator + 1),
  });
  return parsed.success ? parsed.data : undefined;
}
