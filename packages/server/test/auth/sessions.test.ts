import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionStore, isSessionToken } from '../../src/auth/sessions.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('session store', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  const store = (secret = 'secret-a') =>
    createSessionStore({ pool: db.pool, secret, idleMs: 60 * 60_000, maxAgeMs: 2 * 60 * 60_000 });

  it('creates random tokens and finds them only with the same secret', async () => {
    const { token, session } = await store().create({
      username: 'analyst',
      ip: '192.0.2.7',
      userAgent: 'x'.repeat(600),
    });
    expect(isSessionToken(token)).toBe(true);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(2 * 60 * 60_000);
    expect(await store().find(token)).toMatchObject({ username: 'analyst' });
    expect(await store('secret-b').find(token)).toBeUndefined();
    const { rows } = await db.pool.query<{ user_agent: string }>(
      'SELECT user_agent FROM admin_sessions',
    );
    expect(rows[0]?.user_agent).toHaveLength(512);
  });

  it('deletes sessions and purges expired and idle ones', async () => {
    const live = await store().create({ username: 'analyst', ip: null, userAgent: null });
    const expired = await store().create({ username: 'analyst', ip: null, userAgent: null });
    const idle = await store().create({ username: 'analyst', ip: null, userAgent: null });
    await db.pool.query(`UPDATE admin_sessions SET expires_at = now() WHERE id_hash = $1`, [
      expired.session.idHash,
    ]);
    await db.pool.query(
      `UPDATE admin_sessions SET last_seen_at = now() - interval '2 hours' WHERE id_hash = $1`,
      [idle.session.idHash],
    );
    expect(await store().purgeExpired()).toBe(2);
    expect(await store().find(live.token)).toBeDefined();
    await store().delete(live.token);
    expect(await store().find(live.token)).toBeUndefined();
    // Malformed tokens never reach the database.
    await store().delete('not a token');
    expect(await store().find("' OR 1=1 --")).toBeUndefined();
  });
});
