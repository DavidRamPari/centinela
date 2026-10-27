import { createHash } from 'node:crypto';
import { get, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CSRF_COOKIE, SESSION_COOKIE, problemSchema, sessionInfoSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionStoreFor } from '../../src/auth/index.js';
import { createTestApp } from '../helpers/app.js';
import {
  TEST_PASSWORD,
  TEST_USERNAME,
  setCookies,
  signIn,
  signedInHeaders,
} from '../helpers/auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

function expectProblem(res: request.Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  return problemSchema.parse(res.body);
}

describe('sign-in, session and sign-out', () => {
  let db: TestDatabase;
  /** Every test uses its own client address, so lockouts do not leak between tests. */
  let app: ReturnType<typeof createTestApp>['app'];
  let deps: ReturnType<typeof createTestApp>['deps'];
  let nextIp = 1;
  const freshIp = () => `198.51.100.${nextIp++}`;

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app, deps } = createTestApp({
      pool: db.pool,
      signedIn: false,
      // supertest connects from the loopback address, like a proxy on the same host.
      env: { TRUST_PROXY: 'loopback' },
    }));
  });
  afterAll(() => db.cleanup());

  /** Stored key of a session token. */
  const idHash = (token: string) => sessionStoreFor(deps.config, db.pool).idHash(token);

  const login = (ip: string, body: unknown) =>
    request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send(body as object);

  async function auditActions(): Promise<
    Array<{ action: string; actor: string | null; ip: string | null }>
  > {
    const { rows } = await db.pool.query<{
      action: string;
      actor: string | null;
      ip: string | null;
    }>('SELECT action, actor, host(ip) AS ip FROM audit_log ORDER BY seq');
    return rows;
  }

  describe('POST /api/auth/login', () => {
    it('sets a __Host- httpOnly session cookie and a readable CSRF cookie', async () => {
      const ip = freshIp();
      const res = await login(ip, { username: TEST_USERNAME, password: TEST_PASSWORD }).expect(200);
      const info = sessionInfoSchema.parse(res.body);
      expect(info.username).toBe(TEST_USERNAME);
      const hours = (Date.parse(info.expiresAt) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(11.9);
      expect(hours).toBeLessThanOrEqual(12);

      const cookies = setCookies(res);
      const session = cookies.get(SESSION_COOKIE);
      const csrf = cookies.get(CSRF_COOKIE);
      expect(session?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(session?.attributes).toEqual(
        expect.arrayContaining([
          'path=/',
          'httponly',
          'secure',
          'samesite=strict',
          'max-age=43200',
        ]),
      );
      expect(csrf?.attributes).toEqual(
        expect.arrayContaining(['path=/', 'secure', 'samesite=strict', 'max-age=43200']),
      );
      expect(csrf?.attributes).not.toContain('httponly');
      for (const cookie of [session, csrf]) {
        expect(cookie?.attributes.some((a) => a.startsWith('domain='))).toBe(false);
      }

      // Only a keyed hash of the token is stored.
      const { rows } = await db.pool.query<{ id_hash: Buffer; username: string; ip: string }>(
        'SELECT id_hash, username, host(ip) AS ip FROM admin_sessions',
      );
      const token = session?.value ?? '';
      const plain = createHash('sha256').update(`session:${token}`).digest();
      const stored = rows.find((row) => row.ip === ip);
      expect(stored?.username).toBe(TEST_USERNAME);
      expect(stored?.id_hash.equals(plain)).toBe(false);
      expect(stored?.id_hash.toString('utf8')).not.toContain(token);
      expect(await auditActions()).toContainEqual({
        action: 'auth.login',
        actor: TEST_USERNAME,
        ip,
      });
    });

    it('answers 401 with the same message for a wrong password and a wrong user name', async () => {
      const ip = freshIp();
      const wrongPassword = expectProblem(
        await login(ip, { username: TEST_USERNAME, password: 'not-the-password' }),
        401,
      );
      const wrongUser = expectProblem(
        await login(ip, { username: 'mallory<script>', password: TEST_PASSWORD }),
        401,
      );
      expect(wrongUser.detail).toBe(wrongPassword.detail);
      const failed = (await auditActions()).filter((row) => row.ip === ip);
      expect(failed).toEqual([
        { action: 'auth.login_failed', actor: TEST_USERNAME, ip },
        { action: 'auth.login_failed', actor: 'mallory<script>', ip },
      ]);
    });

    it.each([
      ['no body', undefined],
      ['an empty password', { username: TEST_USERNAME, password: '' }],
      ['an unknown key', { username: TEST_USERNAME, password: TEST_PASSWORD, admin: true }],
      ['a user name over 128 characters', { username: 'a'.repeat(129), password: TEST_PASSWORD }],
      ['a password over 1,024 characters', { username: TEST_USERNAME, password: 'a'.repeat(1025) }],
    ])('answers 400 for %s', async (_label, body) => {
      expectProblem(await login(freshIp(), body ?? {}), 400);
    });

    it('answers 413 above 4 kB and 400 for form-encoded posts', async () => {
      const ip = freshIp();
      expectProblem(await login(ip, { username: TEST_USERNAME, password: 'x'.repeat(5000) }), 413);
      // A cross-site HTML form cannot send JSON: a form-encoded body is not read at all.
      const form = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .type('form')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
      expectProblem(form, 400);
    });

    it('replaces the session the browser already holds', async () => {
      const first = await signIn(app);
      const res = await request(app)
        .post('/api/auth/login')
        .set('Cookie', first.cookie)
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
        .expect(200);
      expect(setCookies(res).get(SESSION_COOKIE)?.value).not.toBe(first.token);
      await request(app).get('/api/auth/me').set('Cookie', first.cookie).expect(401);
    });
  });

  describe('lockout', () => {
    it('locks a client out after 5 failures, even for the right password', async () => {
      const ip = freshIp();
      const wrong = { username: TEST_USERNAME, password: 'guess' };
      for (let i = 0; i < 4; i += 1) expectProblem(await login(ip, wrong), 401);
      const fifth = await login(ip, wrong);
      expectProblem(fifth, 429);
      expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(14 * 60);
      const right = await login(ip, { username: TEST_USERNAME, password: TEST_PASSWORD });
      expectProblem(right, 429);
      expect(setCookies(right).size).toBe(0);
      const rows = (await auditActions()).filter((row) => row.ip === ip).map((row) => row.action);
      expect(rows).toEqual([...Array<string>(5).fill('auth.login_failed'), 'auth.lockout']);

      // Other clients are not affected.
      await login(freshIp(), { username: TEST_USERNAME, password: TEST_PASSWORD }).expect(200);
    });

    it('clears the failure count after a successful sign-in', async () => {
      const ip = freshIp();
      const wrong = { username: TEST_USERNAME, password: 'guess' };
      for (let i = 0; i < 4; i += 1) expectProblem(await login(ip, wrong), 401);
      await login(ip, { username: TEST_USERNAME, password: TEST_PASSWORD }).expect(200);
      for (let i = 0; i < 4; i += 1) expectProblem(await login(ip, wrong), 401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('describes the session and re-issues the CSRF cookie', async () => {
      const session = await signIn(app);
      const res = await request(app).get('/api/auth/me').set('Cookie', session.cookie).expect(200);
      expect(sessionInfoSchema.parse(res.body).username).toBe(TEST_USERNAME);
      expect(setCookies(res).get(CSRF_COOKIE)?.value).toBe(session.csrf);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each([
      ['no cookie', undefined],
      ['a malformed token', `${SESSION_COOKIE}=not-a-token`],
      ['an unknown token', `${SESSION_COOKIE}=${'A'.repeat(43)}`],
    ])('answers 401 with %s', async (_label, cookie) => {
      const req = request(app).get('/api/auth/me');
      if (cookie) req.set('Cookie', cookie);
      expectProblem(await req, 401);
    });

    it('answers 401 once the session expired or sat idle for too long', async () => {
      const expired = await signIn(app);
      const idle = await signIn(app);
      await db.pool.query(
        `UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1`,
        [idHash(expired.token)],
      );
      await db.pool.query(
        `UPDATE admin_sessions SET last_seen_at = now() - interval '121 minutes' WHERE id_hash = $1`,
        [idHash(idle.token)],
      );
      expectProblem(await request(app).get('/api/auth/me').set('Cookie', expired.cookie), 401);
      expectProblem(await request(app).get('/api/auth/me').set('Cookie', idle.cookie), 401);
    });

    it('does not count as activity, while other requests do', async () => {
      const session = await signIn(app);
      const lastSeen = async () => {
        const { rows } = await db.pool.query<{ last_seen_at: Date }>(
          'SELECT last_seen_at FROM admin_sessions WHERE id_hash = $1',
          [idHash(session.token)],
        );
        return rows[0]?.last_seen_at.getTime() ?? 0;
      };
      await db.pool.query(
        `UPDATE admin_sessions SET last_seen_at = now() - interval '10 minutes' WHERE id_hash = $1`,
        [idHash(session.token)],
      );
      const before = await lastSeen();
      await request(app).get('/api/auth/me').set('Cookie', session.cookie).expect(200);
      expect(await lastSeen()).toBe(before);
      await request(app).get('/api/tokens').set('Cookie', session.cookie).expect(200);
      expect(await lastSeen()).toBeGreaterThan(before + 9 * 60_000);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('needs the CSRF token, then deletes the session and clears both cookies', async () => {
      const session = await signIn(app);
      expectProblem(await request(app).post('/api/auth/logout').set('Cookie', session.cookie), 403);
      await request(app).get('/api/auth/me').set('Cookie', session.cookie).expect(200);

      const res = await request(app).post('/api/auth/logout').set(session.headers).expect(204);
      const cleared = setCookies(res);
      for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
        expect(cleared.get(name)?.value).toBe('');
        expect(
          cleared.get(name)?.attributes.some((a) => a.startsWith('expires=thu, 01 jan 1970')),
        ).toBe(true);
      }
      expectProblem(await request(app).get('/api/auth/me').set('Cookie', session.cookie), 401);
      expect((await auditActions()).map((row) => row.action)).toContain('auth.logout');
    });

    it('answers 401 without a session', async () => {
      expectProblem(await request(app).post('/api/auth/logout'), 401);
    });
  });

  it('refuses sessions of a user name that is no longer the admin', async () => {
    const session = await signIn(app);
    const { app: renamed } = createTestApp({
      pool: db.pool,
      signedIn: false,
      env: { ADMIN_USERNAME: 'someone-else' },
    });
    expectProblem(await request(renamed).get('/api/auth/me').set('Cookie', session.cookie), 401);
  });

  it('rate-limits every /api/auth request per client', async () => {
    const { app: limited } = createTestApp({
      pool: db.pool,
      signedIn: false,
      env: { RATE_LIMIT_AUTH_PER_MINUTE: '3' },
    });
    for (let i = 0; i < 3; i += 1) await request(limited).get('/api/auth/me').expect(401);
    const res = await request(limited)
      .post('/api/auth/login')
      .send({ username: 'a', password: 'b' });
    expectProblem(res, 429);
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });

  describe('live streams', () => {
    let server: Server;
    let port: number;
    let testApp: ReturnType<typeof createTestApp>;

    beforeAll(async () => {
      testApp = createTestApp({ pool: db.pool, signedIn: false });
      server = testApp.app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      testApp.deps.hub.close();
      await new Promise((resolve) => server.close(resolve));
    });

    function openStream(cookie?: string): Promise<IncomingMessage> {
      return new Promise((resolve, reject) => {
        const req = get({
          port,
          path: '/api/stream',
          headers: { Accept: 'text/event-stream', ...(cookie ? { Cookie: cookie } : {}) },
        });
        req.on('error', reject);
        req.on('response', resolve);
      });
    }

    it('needs a session and ends when the session signs out', async () => {
      const anonymous = await openStream();
      expect(anonymous.statusCode).toBe(401);
      anonymous.resume();

      const session = await signIn(server);
      const other = await signIn(server);
      const stream = await openStream(session.cookie);
      const otherStream = await openStream(other.cookie);
      expect(stream.statusCode).toBe(200);
      stream.resume();
      otherStream.resume();
      const ended = new Promise<void>((resolve) => stream.once('end', resolve));
      let otherEnded = false;
      otherStream.once('end', () => {
        otherEnded = true;
      });

      await request(server).post('/api/auth/logout').set(session.headers).expect(204);
      await ended;
      expect(otherEnded).toBe(false);
      otherStream.destroy();
    });
  });

  it('builds the expected headers for a signed-in browser', () => {
    expect(signedInHeaders('t', 'c').headers).toEqual({
      Cookie: `${SESSION_COOKIE}=t; ${CSRF_COOKIE}=c`,
      'X-CSRF-Token': 'c',
    });
  });
});
