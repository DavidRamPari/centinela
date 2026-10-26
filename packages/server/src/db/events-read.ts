/**
 * Event queries for `GET /api/events` and `GET /api/events/:id` (ARCHITECTURE §9):
 * filters on the indexed columns, full-text search on `message`, keyset pagination
 * newest first by `(ts, id)`.
 */
import type { NormalizedEvent, Outcome, Page, SourceType } from '@centinela/shared';
import type { Pool } from 'pg';
import { encodeCursor, type KeysetPosition } from './cursor.js';
import { EVENT_COLUMNS, eventFromRow, type EventRow } from './rows.js';
import { SqlParams, whereClause } from './sql.js';

export interface TimeRange {
  from: Date;
  to: Date;
}

export interface EventFilter extends TimeRange {
  source?: SourceType | undefined;
  /** Case-insensitive. */
  host?: string | undefined;
  user?: string | undefined;
  /** A valid IPv4 or IPv6 address (validated by the caller). */
  ip?: string | undefined;
  action?: string | undefined;
  outcome?: Outcome | undefined;
  /** Free text: every word must start a token of `message` (see `prefixTsQuery`). */
  q?: string | undefined;
  after?: KeysetPosition | undefined;
  limit: number;
}

/**
 * A `to_tsquery` text in which every whitespace-separated word of `text` is a quoted
 * prefix term (`'word':*`) and the terms are AND-ed. Quoting makes every operator
 * character literal; quotes and backslashes are escaped as the tsquery syntax requires.
 * Prefix terms let `sqlmap` find the token `sqlmap/1.8` and `nikto` find `nikto/2.5.0`.
 */
export function prefixTsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `'${word.replaceAll('\\', '\\\\').replaceAll("'", "''")}':*`)
    .join(' & ');
}

/** `to_tsvector('simple', message)` is the expression of the `events_message_fts` index. */
const MESSAGE_TSVECTOR = "to_tsvector('simple', e.message)";

function eventConditions(filter: EventFilter, params: SqlParams): string[] {
  const conditions = [`e.ts >= ${params.add(filter.from)}`, `e.ts <= ${params.add(filter.to)}`];
  if (filter.source) conditions.push(`e.source = ${params.add(filter.source)}`);
  if (filter.host) conditions.push(`lower(e.host) = lower(${params.add(filter.host)})`);
  if (filter.user) conditions.push(`e.user_name = ${params.add(filter.user)}`);
  if (filter.ip) conditions.push(`e.src_ip = ${params.add(filter.ip)}::inet`);
  if (filter.action) conditions.push(`e.action = ${params.add(filter.action)}`);
  if (filter.outcome) conditions.push(`e.outcome = ${params.add(filter.outcome)}`);
  if (filter.q) {
    conditions.push(
      `${MESSAGE_TSVECTOR} @@ to_tsquery('simple', ${params.add(prefixTsQuery(filter.q))})`,
    );
  }
  return conditions;
}

export async function listEvents(pool: Pool, filter: EventFilter): Promise<Page<NormalizedEvent>> {
  const params = new SqlParams();
  const conditions = eventConditions(filter, params);
  if (filter.after) {
    conditions.push(
      `(e.ts, e.id) < (${params.add(filter.after.ts)}::timestamptz, ${params.add(filter.after.id)}::uuid)`,
    );
  }
  // One extra row tells whether another page exists.
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e ${whereClause(conditions)}
      ORDER BY e.ts DESC, e.id DESC LIMIT ${params.add(filter.limit + 1)}`,
    params.values,
  );
  const items = rows.slice(0, filter.limit).map(eventFromRow);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > filter.limit && last ? encodeCursor(last) : null,
  };
}

export async function getEvent(pool: Pool, id: string): Promise<NormalizedEvent | undefined> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? undefined : eventFromRow(row);
}

/** Events linked to an alert, oldest first (the alert timeline). */
export async function eventsForAlert(
  pool: Pool,
  alertId: string,
  limit: number,
): Promise<NormalizedEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS}
       FROM alert_events ae JOIN events e ON e.id = ae.event_id
      WHERE ae.alert_id = $1
      ORDER BY e.ts, e.id
      LIMIT $2`,
    [alertId, limit],
  );
  return rows.map(eventFromRow);
}
