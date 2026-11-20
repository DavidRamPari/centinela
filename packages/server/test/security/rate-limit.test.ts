import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWindowCounter, DEFAULT_MAX_COUNTER_KEYS } from '../../src/security/rate-limit.js';
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

describe('createWindowCounter (S11)', () => {
  it('allows `limit` counts per key and window, then says how long to wait', () => {
    let now = 0;
    const counter = createWindowCounter({ windowMs: 60_000, limit: 2 }, { now: () => now });
    expect(counter.wait('a')).toBe(0);
    counter.add('a');
    counter.add('a');
    expect(counter.wait('a')).toBe(60);
    expect(counter.wait('b')).toBe(0);
    now = 59_001;
    expect(counter.wait('a')).toBe(1);
    now = 60_000;
    expect(counter.wait('a')).toBe(0);
    counter.add('a');
    expect(counter.wait('a')).toBe(0);
  });

  it('keeps at most maxKeys windows: expired ones go first, then the oldest', () => {
    let now = 0;
    const counter = createWindowCounter(
      { windowMs: 1_000, limit: 1 },
      { now: () => now, maxKeys: 2 },
    );
    counter.add('old');
    now = 500;
    counter.add('a');
    now = 1_200; // 'old' expired, 'a' has not
    counter.add('b');
    expect(counter.wait('a')).toBeGreaterThan(0);
    expect(counter.wait('b')).toBeGreaterThan(0);
    counter.add('c'); // full of live windows: the oldest ('a') goes
    expect(counter.wait('a')).toBe(0);
    expect(counter.wait('b')).toBeGreaterThan(0);
    expect(counter.wait('c')).toBeGreaterThan(0);
  });

  it('stays cheap for a new key when the table is full of live windows (S11-R04)', () => {
    // Requests without a valid token from as many addresses as the table holds: an IPv6
    // client has more than enough. Each new address must not scan the whole table.
    const counter = createWindowCounter({ windowMs: 60_000, limit: 1 });
    for (let i = 0; i < DEFAULT_MAX_COUNTER_KEYS; i += 1) {
      counter.add(`2001:db8::${i.toString(16)}`);
    }
    const started = performance.now();
    for (let i = 0; i < 2_000; i += 1) counter.add(`2001:db8:1::${i.toString(16)}`);
    expect(performance.now() - started).toBeLessThan(250);
    // The oldest windows made room; the newest are kept.
    expect(counter.wait('2001:db8::0')).toBe(0);
    expect(counter.wait(`2001:db8::${(DEFAULT_MAX_COUNTER_KEYS - 1).toString(16)}`)).toBe(60);
    expect(counter.wait('2001:db8:1::7cf')).toBe(60);
  });

  it('takes a count back only in the window it was made in', () => {
    let now = 0;
    const counter = createWindowCounter({ windowMs: 1_000, limit: 1 }, { now: () => now });
    const first = counter.add('a');
    expect(counter.wait('a')).toBe(1);
    counter.remove('a', first);
    expect(counter.wait('a')).toBe(0);
    const second = counter.add('a');
    now = 1_500; // that window ended and another one started
    counter.add('a');
    counter.remove('a', second);
    expect(counter.wait('a')).toBe(1);
  });
});
