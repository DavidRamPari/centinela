/**
 * PostgreSQL `EventStore` (ARCHITECTURE §2.3, §8). Events are written with one
 * `INSERT ... SELECT FROM unnest(...)` statement per chunk of at most 1,000 events: one
 * round trip per chunk, a fixed number of parameters (one array per column) whatever the
 * chunk size, and no SQL built from event content.
 */
import type { NormalizedEvent } from '@centinela/shared';
import type { Pool } from 'pg';
import type { EventStore } from '../pipeline/types.js';

/** Events per INSERT statement (ARCHITECTURE §12: at most one round trip per 1,000). */
export const INSERT_CHUNK_SIZE = 1000;

const INSERT_EVENTS = `
INSERT INTO events (
  id, ts, ingested_at, source, host, category, action, outcome,
  user_name, src_ip, src_port, message, fields
)
SELECT * FROM unnest(
  $1::uuid[], $2::timestamptz[], $3::timestamptz[], $4::text[], $5::text[], $6::text[],
  $7::text[], $8::text[], $9::text[], $10::inet[], $11::integer[], $12::text[], $13::jsonb[]
)`;

/** Column arrays for one chunk, in the order of the `unnest` parameters. */
export function toColumns(events: readonly NormalizedEvent[]): unknown[][] {
  const columns: unknown[][] = Array.from({ length: 13 }, () => new Array<unknown>(events.length));
  events.forEach((e, i) => {
    const values = [
      e.id,
      e.ts,
      e.ingestedAt,
      e.source,
      e.host,
      e.category,
      e.action,
      e.outcome,
      e.user ?? null,
      e.srcIp ?? null,
      e.srcPort ?? null,
      e.message,
      JSON.stringify(e.fields),
    ];
    values.forEach((value, column) => {
      (columns[column] as unknown[])[i] = value;
    });
  });
  return columns;
}

export function createEventStore(pool?: Pool): EventStore {
  return {
    async insertMany(events) {
      if (events.length === 0) return;
      if (!pool) throw new Error('event store: no database pool configured');
      for (let start = 0; start < events.length; start += INSERT_CHUNK_SIZE) {
        const chunk = events.slice(start, start + INSERT_CHUNK_SIZE);
        await pool.query(INSERT_EVENTS, toColumns(chunk));
      }
    },
  };
}
