/**
 * Ingest tokens (`ingest_tokens`): bearer tokens for `POST /api/ingest`, created and
 * revoked from the dashboard.
 *
 * A secret is `cnt_` followed by 32 random bytes in base64url. Only its SHA-256 is stored:
 * the secret has 256 bits of entropy, so a fast hash is enough (no dictionary to attack)
 * and lookups stay a single indexed equality. The secret is shown once, at creation; the
 * dashboard keeps showing its first characters (`prefix`) so tokens can be told apart.
 * `INGEST_TOKEN` from the environment keeps working next to these tokens (bootstrap and
 * scripts); it is rotated by changing the variable.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ingestTokenSchema, type IngestToken } from '@centinela/shared';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { safeEqual } from '../security/compare.js';
import type { Queryable } from './audit.js';

export const TOKEN_SECRET_PREFIX = 'cnt_';
const SECRET_PATTERN = /^cnt_[A-Za-z0-9_-]{43}$/;
/** Characters of the secret kept for display (`cnt_` and 8 more: 48 of 256 bits). */
const DISPLAY_PREFIX_LENGTH = 12;
/** Active (not revoked) tokens allowed at once. */
export const MAX_ACTIVE_TOKENS = 50;
/** The list shows the newest tokens, revoked ones included. */
export const MAX_LISTED_TOKENS = 200;
/** `last_used_at` is written at most once a minute per token. */
const TOUCH_INTERVAL_MS = 60_000;

export function generateTokenSecret(): string {
  return `${TOKEN_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashTokenSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

interface TokenRow {
  id: string;
  label: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const TOKEN_COLUMNS = 'id, label, prefix, created_at, last_used_at, revoked_at';

function tokenFromRow(row: TokenRow): IngestToken {
  return ingestTokenSchema.parse({
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
}

export async function listTokens(pool: Pool): Promise<IngestToken[]> {
  const { rows } = await pool.query<TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM ingest_tokens ORDER BY created_at DESC, id DESC LIMIT $1`,
    [MAX_LISTED_TOKENS],
  );
  return rows.map(tokenFromRow);
}

export type CreateTokenResult =
  { ok: true; token: IngestToken; secret: string } | { ok: false; reason: 'too-many' };

/**
 * Create a token inside the caller's transaction. A transaction-level advisory lock makes
 * the active-token count and the insert atomic across concurrent requests.
 */
export async function createToken(
  client: Queryable,
  input: { label: string; createdBy: string },
): Promise<CreateTokenResult> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('centinela.ingest_tokens'))`);
  const { rows: counted } = await client.query<{ count: string }>(
    'SELECT count(*) AS count FROM ingest_tokens WHERE revoked_at IS NULL',
  );
  if (Number(counted[0]?.count ?? 0) >= MAX_ACTIVE_TOKENS) return { ok: false, reason: 'too-many' };
  const secret = generateTokenSecret();
  const { rows } = await client.query<TokenRow>(
    `INSERT INTO ingest_tokens (id, label, token_hash, prefix, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${TOKEN_COLUMNS}`,
    [
      uuidv7(),
      input.label,
      hashTokenSecret(secret),
      secret.slice(0, DISPLAY_PREFIX_LENGTH),
      input.createdBy,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('token insert returned no row');
  return { ok: true, token: tokenFromRow(row), secret };
}

export type RevokeTokenResult =
  { ok: true; token: IngestToken; changed: boolean } | { ok: false; reason: 'not-found' };

/** Revoke a token; revoking it again keeps the first revocation time. */
export async function revokeToken(
  client: Queryable,
  id: string,
  revokedBy: string,
): Promise<RevokeTokenResult> {
  const { rows } = await client.query<TokenRow>(
    `UPDATE ingest_tokens SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING ${TOKEN_COLUMNS}`,
    [id, revokedBy],
  );
  const revoked = rows[0];
  if (revoked) return { ok: true, token: tokenFromRow(revoked), changed: true };
  const { rows: existing } = await client.query<TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM ingest_tokens WHERE id = $1`,
    [id],
  );
  const row = existing[0];
  return row
    ? { ok: true, token: tokenFromRow(row), changed: false }
    : { ok: false, reason: 'not-found' };
}

/**
 * Checks a bearer token for `POST /api/ingest`: `INGEST_TOKEN` (constant-time comparison)
 * or an active token from the table. Only well-formed `cnt_` secrets reach the database.
 */
export function createIngestTokenVerifier(pool: Pool, configToken: string) {
  return async (presented: string): Promise<boolean> => {
    if (safeEqual(presented, configToken)) return true;
    if (!SECRET_PATTERN.test(presented)) return false;
    const { rows } = await pool.query<{ id: string }>(
      `WITH active AS (
         SELECT id, last_used_at FROM ingest_tokens WHERE token_hash = $1 AND revoked_at IS NULL
       ), touched AS (
         UPDATE ingest_tokens t SET last_used_at = now()
           FROM active
          WHERE t.id = active.id
            AND (active.last_used_at IS NULL
                 OR active.last_used_at < now() - $2::double precision * interval '1 millisecond')
       )
       SELECT id FROM active`,
      [hashTokenSecret(presented), TOUCH_INTERVAL_MS],
    );
    return rows.length > 0;
  };
}
