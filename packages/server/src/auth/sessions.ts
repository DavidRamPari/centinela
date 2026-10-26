/**
 * Server-side sessions in PostgreSQL (`admin_sessions`).
 *
 * The cookie carries a random 256-bit token. The table stores only HMAC-SHA256(SESSION_SECRET,
 * token), so neither a database dump nor a SQL injection elsewhere yields usable cookies,
 * and rows cannot be forged without the secret. A session ends after `idleMs` without
 * requests or at `expiresAt`, whichever comes first; sign-out deletes the row.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/** base64url of 32 random bytes. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** `last_seen_at` is written at most once a minute per session, not on every request. */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_USER_AGENT_LENGTH = 512;

export interface Session {
  idHash: Buffer;
  username: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface NewSession {
  username: string;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionStore {
  /** Create a session; the token goes into the cookie and is never stored. */
  create(input: NewSession): Promise<{ token: string; session: Session }>;
  /** The live session for a cookie token. `touch` records the request (idle timeout). */
  find(token: string, options?: { touch?: boolean }): Promise<Session | undefined>;
  /** Delete the session of a cookie token (sign-out); unknown tokens are ignored. */
  delete(token: string): Promise<void>;
  /** Delete expired and idle sessions; returns how many were removed. */
  purgeExpired(): Promise<number>;
  /** The stored key of a cookie token. */
  idHash(token: string): Buffer;
}

export interface SessionStoreOptions {
  pool: Pool;
  secret: string;
  idleMs: number;
  maxAgeMs: number;
}

export function isSessionToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

interface SessionRow {
  username: string;
  created_at: Date;
  expires_at: Date;
}

export function createSessionStore({
  pool,
  secret,
  idleMs,
  maxAgeMs,
}: SessionStoreOptions): SessionStore {
  const idHash = (token: string) =>
    createHmac('sha256', secret).update(`session:${token}`, 'utf8').digest();

  async function purgeExpired(): Promise<number> {
    const { rowCount } = await pool.query(
      `DELETE FROM admin_sessions
        WHERE expires_at <= now() OR last_seen_at <= now() - $1::double precision * interval '1 millisecond'`,
      [idleMs],
    );
    return rowCount ?? 0;
  }

  return {
    idHash,
    purgeExpired,

    async create({ username, ip, userAgent }) {
      await purgeExpired();
      const token = randomBytes(32).toString('base64url');
      const hash = idHash(token);
      const { rows } = await pool.query<SessionRow>(
        `INSERT INTO admin_sessions (id_hash, username, expires_at, ip, user_agent)
         VALUES ($1, $2, now() + $3::double precision * interval '1 millisecond', $4, $5)
         RETURNING username, created_at, expires_at`,
        [hash, username, maxAgeMs, ip, userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null],
      );
      const row = rows[0];
      if (!row) throw new Error('session insert returned no row');
      return {
        token,
        session: {
          idHash: hash,
          username: row.username,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        },
      };
    },

    async find(token, { touch = true } = {}) {
      if (!isSessionToken(token)) return undefined;
      const hash = idHash(token);
      // One round trip: read the live session and, when asked and due, record the request.
      const { rows } = await pool.query<SessionRow>(
        `WITH live AS (
           SELECT id_hash, username, created_at, expires_at, last_seen_at
             FROM admin_sessions
            WHERE id_hash = $1
              AND expires_at > now()
              AND last_seen_at > now() - $2::double precision * interval '1 millisecond'
         ), touched AS (
           UPDATE admin_sessions s SET last_seen_at = now()
             FROM live
            WHERE $3::boolean
              AND s.id_hash = live.id_hash
              AND live.last_seen_at < now() - $4::double precision * interval '1 millisecond'
         )
         SELECT username, created_at, expires_at FROM live`,
        [hash, idleMs, touch, TOUCH_INTERVAL_MS],
      );
      const row = rows[0];
      return row
        ? {
            idHash: hash,
            username: row.username,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          }
        : undefined;
    },

    async delete(token) {
      if (!isSessionToken(token)) return;
      await pool.query('DELETE FROM admin_sessions WHERE id_hash = $1', [idHash(token)]);
    },
  };
}
