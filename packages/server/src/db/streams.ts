/**
 * PostgreSQL `StreamRegistry` (ARCHITECTURE §8.1): one `ingest_streams` row per delivery
 * path, created on first use, with its counters and last signal updated once per ingest
 * call. The stream id is stored on every event (`events.stream_id`), which answers "which
 * credential delivered this" after a token is found compromised.
 */
import { DEFAULT_TENANT_ID } from '@centinela/shared';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { StreamLimitError, type StreamKey, type StreamRegistry } from '../pipeline/types.js';
import { toCount } from './sql.js';

/**
 * `host` is a query parameter of the ingest endpoint, so the holder of a token chooses how
 * many rows it creates. This bounds them.
 */
export const MAX_STREAMS_PER_TOKEN = 1000;
/** Resolved ids kept in memory; past this the cache starts again. */
const MAX_CACHED_STREAMS = 10_000;

const FIND = `
SELECT id FROM ingest_streams
 WHERE tenant_id = $1 AND kind = $2 AND token_id IS NOT DISTINCT FROM $3::uuid
   AND source = $4 AND host = $5`;

const COUNT_FOR_TOKEN = `
SELECT count(*) AS count FROM ingest_streams
 WHERE tenant_id = $1 AND kind = 'token' AND token_id IS NOT DISTINCT FROM $2::uuid`;

const INSERT = `
INSERT INTO ingest_streams (id, tenant_id, kind, token_id, source, host)
VALUES ($1, $2, $3, $4::uuid, $5, $6)
ON CONFLICT DO NOTHING`;

const RECORD = `
UPDATE ingest_streams
   SET accepted = accepted + $2,
       rejected = rejected + $3,
       late = late + $4,
       last_seen_at = GREATEST(last_seen_at, $5::timestamptz),
       last_event_ts = GREATEST(last_event_ts, $6::timestamptz)
 WHERE id = $1`;

export interface StreamRegistryOptions {
  newId?: () => string;
}

export function createStreamRegistry(
  pool: Pool,
  options: StreamRegistryOptions = {},
): StreamRegistry {
  const newId = options.newId ?? (() => uuidv7());
  const cache = new Map<string, string>();

  async function find(key: StreamKey): Promise<string | undefined> {
    const { rows } = await pool.query<{ id: string }>(FIND, [
      DEFAULT_TENANT_ID,
      key.kind,
      key.tokenId,
      key.source,
      key.host,
    ]);
    return rows[0]?.id;
  }

  return {
    async resolve(key) {
      const cacheKey = JSON.stringify([key.kind, key.tokenId, key.source, key.host]);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;

      let id = await find(key);
      if (id === undefined) {
        if (key.kind === 'token') {
          const { rows } = await pool.query<{ count: string }>(COUNT_FOR_TOKEN, [
            DEFAULT_TENANT_ID,
            key.tokenId,
          ]);
          if (toCount(rows[0]?.count) >= MAX_STREAMS_PER_TOKEN) {
            throw new StreamLimitError(MAX_STREAMS_PER_TOKEN);
          }
        }
        await pool.query(INSERT, [
          newId(),
          DEFAULT_TENANT_ID,
          key.kind,
          key.tokenId,
          key.source,
          key.host,
        ]);
        // Another process may have created the row first; read whichever one exists.
        id = await find(key);
        if (id === undefined) throw new Error('ingest stream could not be created');
      }
      if (cache.size >= MAX_CACHED_STREAMS) cache.clear();
      cache.set(cacheKey, id);
      return id;
    },

    async record(id, counts) {
      await pool.query(RECORD, [
        id,
        counts.accepted,
        counts.rejected,
        counts.late,
        counts.at,
        counts.lastEventTs,
      ]);
    },
  };
}
