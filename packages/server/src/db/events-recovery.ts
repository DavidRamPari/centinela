/**
 * PostgreSQL `EventReader` (ARCHITECTURE §6.3): stored events read back for the detector
 * when the server restores a checkpoint.
 */
import type { NormalizedEvent } from '@centinela/shared';
import type { Pool } from 'pg';
import type { EventReader } from '../pipeline/types.js';
import { EVENT_COLUMNS, eventFromRow, type EventRow } from './rows.js';

const BY_IDS = `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = ANY($1::uuid[])`;

/**
 * Events of the server's own streams after a position. Events without a stream were
 * stored before streams existed, and the command line evaluates what it stores itself.
 */
const AFTER = `
SELECT ${EVENT_COLUMNS}
  FROM events e JOIN ingest_streams s ON s.id = e.stream_id
 WHERE ($1::uuid IS NULL OR e.id > $1::uuid) AND s.kind <> 'cli'
 ORDER BY e.id
 LIMIT $2`;

const NEWEST = 'SELECT e.id FROM events e ORDER BY e.id DESC LIMIT 1';

export function createEventReader(pool: Pool): EventReader {
  return {
    async byIds(ids): Promise<NormalizedEvent[]> {
      if (ids.length === 0) return [];
      const { rows } = await pool.query<EventRow>(BY_IDS, [ids]);
      return rows.map(eventFromRow);
    },
    async after(position, limit): Promise<NormalizedEvent[]> {
      const { rows } = await pool.query<EventRow>(AFTER, [position, limit]);
      return rows.map(eventFromRow);
    },
    async newestId(): Promise<string | null> {
      const { rows } = await pool.query<{ id: string }>(NEWEST);
      return rows[0]?.id ?? null;
    },
  };
}
