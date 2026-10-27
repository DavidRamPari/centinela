import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * express-rate-limit checks its setup on the first request of each limiter and reports
 * problems with console.error (ERR_ERL_*), for example a `trust proxy` of `true`, which
 * lets clients choose their IP. The settings TRUST_PROXY allows must pass those checks.
 */
describe('rate limiters and TRUST_PROXY', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([['false'], ['1'], ['loopback'], ['127.0.0.1, ::1']])(
    'raise no express-rate-limit errors with TRUST_PROXY=%s',
    async (trustProxy) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { app } = createTestApp({
        pool: db.pool,
        signedIn: false,
        env: { TRUST_PROXY: trustProxy },
      });
      const forwarded = trustProxy === 'false' ? {} : { 'X-Forwarded-For': '198.51.100.7' };
      await request(app).get('/api/auth/me').set(forwarded).expect(401);
      await request(app)
        .post('/api/ingest?source=linux_auth')
        .set(forwarded)
        .type('text/plain')
        .send('')
        .expect(401);
      await request(app)
        .post('/api/ingest/upload?source=linux_auth')
        .set(forwarded)
        .type('text/plain')
        .send('')
        .expect(401);
      const reported = errors.mock.calls.map((call) => call.map(String).join(' '));
      expect(reported.filter((text) => text.includes('ERR_ERL'))).toEqual([]);
    },
  );

  it('uses the forwarded client address only from a trusted proxy', async () => {
    const { app } = createTestApp({
      pool: db.pool,
      signedIn: false,
      env: { TRUST_PROXY: 'loopback', LOGIN_MAX_FAILURES: '1' },
    });
    const wrong = { username: 'nobody', password: 'wrong-password' };
    // supertest connects over loopback, so X-Forwarded-For names the client.
    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.8')
      .send(wrong)
      .expect(429);
    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.9')
      .send(wrong)
      .expect(429);
    const { rows } = await db.pool.query<{ ip: string }>(
      `SELECT DISTINCT host(ip) AS ip FROM audit_log WHERE action = 'auth.lockout' ORDER BY 1`,
    );
    expect(rows.map((row) => row.ip)).toEqual(['198.51.100.8', '198.51.100.9']);
  });
});
