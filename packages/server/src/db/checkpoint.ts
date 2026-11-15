/**
 * PostgreSQL `CheckpointStore` (ARCHITECTURE §6.3, §8.1): the detector's state as one row
 * of `detector_checkpoints`, a gzip of its JSON snapshot. Only the server writes it; the
 * command line keeps its state for the length of a run.
 */
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { DEFAULT_TENANT_ID } from '@centinela/shared';
import type { Pool } from 'pg';
import type { Checkpoint, CheckpointStore } from '../pipeline/types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** A saved state never inflates past this, whatever the row holds. */
export const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;

export const LIVE_CHECKPOINT = 'live';

const LOAD = `
SELECT position, state, state_version FROM detector_checkpoints
 WHERE tenant_id = $1 AND name = $2`;

const SAVE = `
INSERT INTO detector_checkpoints (tenant_id, name, position, state, state_version, updated_at)
VALUES ($1, $2, $3::uuid, $4, $5, now())
ON CONFLICT (tenant_id, name) DO UPDATE
   SET position = EXCLUDED.position, state = EXCLUDED.state,
       state_version = EXCLUDED.state_version, updated_at = EXCLUDED.updated_at`;

interface CheckpointRow {
  position: string | null;
  state: Buffer;
  state_version: number;
}

export function createCheckpointStore(pool: Pool, name: string = LIVE_CHECKPOINT): CheckpointStore {
  return {
    async load(): Promise<Checkpoint | null> {
      const { rows } = await pool.query<CheckpointRow>(LOAD, [DEFAULT_TENANT_ID, name]);
      const row = rows[0];
      if (row === undefined) return null;
      let state: unknown;
      try {
        const json = await gunzipAsync(row.state, { maxOutputLength: MAX_CHECKPOINT_BYTES });
        state = JSON.parse(json.toString('utf8'));
      } catch {
        // Unreadable state: the caller's validation refuses it and starts clean, keeping
        // the position so nothing stored after it goes unevaluated.
        state = undefined;
      }
      return { position: row.position, version: row.state_version, state };
    },

    async save(checkpoint) {
      const state = await gzipAsync(Buffer.from(JSON.stringify(checkpoint.state), 'utf8'));
      await pool.query(SAVE, [
        DEFAULT_TENANT_ID,
        name,
        checkpoint.position,
        state,
        checkpoint.version,
      ]);
    },
  };
}
