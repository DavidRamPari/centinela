import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@centinela/shared';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createErrorHandler } from '../../src/http/errors.js';
import { createLogger } from '../../src/logger.js';
import { readCookie } from '../../src/security/cookies.js';
import { csrfTokenFor, isStateChanging, requireCsrfToken } from '../../src/security/csrf.js';
import { createTestApp } from '../helpers/app.js';
import { createSignedInSession, type SignedIn } from '../helpers/auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('CSRF tokens', () => {
  it('are bound to the session token and to the secret', () => {
    const token = 'A'.repeat(43);
    expect(csrfTokenFor('secret', token)).toBe(csrfTokenFor('secret', token));
    expect(csrfTokenFor('secret', token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenFor('secret', 'B'.repeat(43))).not.toBe(csrfTokenFor('secret', token));
    expect(csrfTokenFor('other', token)).not.toBe(csrfTokenFor('secret', token));
    // The CSRF token reveals nothing of the session token it was derived from.
    expect(csrfTokenFor('secret', token)).not.toContain(token.slice(0, 8));
  });

  it('are required for every method except GET, HEAD and OPTIONS', () => {
    expect(['GET', 'head', 'OPTIONS'].map(isStateChanging)).toEqual([false, false, false]);
    expect(['POST', 'PATCH', 'PUT', 'DELETE'].map(isStateChanging)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('reads cookies by exact name, first occurrence only', () => {
    const header = `${CSRF_COOKIE}=csrf; ${SESSION_COOKIE}=one; ${SESSION_COOKIE}=two; x=${SESSION_COOKIE}=3`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('one');
    expect(readCookie(header, CSRF_COOKIE)).toBe('csrf');
    expect(readCookie(header, '__Host-centinel')).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });

  describe('middleware', () => {
    const app = express();
    app.use(requireCsrfToken(() => 'expected-token'));
    app.all('/x', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(createErrorHandler(createLogger({ logLevel: 'silent' })));
    const cookie = `${CSRF_COOKIE}=expected-token`;

    it.each([
      ['no header and no cookie', {}],
      ['a header without the cookie', { [CSRF_HEADER]: 'expected-token' }],
      ['the cookie without the header', { Cookie: cookie }],
      ['a header that differs from the cookie', { Cookie: cookie, [CSRF_HEADER]: 'forged' }],
      [
        'header and cookie that agree but belong to another session',
        { Cookie: `${CSRF_COOKIE}=other`, [CSRF_HEADER]: 'other' },
      ],
    ])('answers 403 to a POST with %s', async (_label, headers: Record<string, string>) => {
      await request(app).post('/x').set(headers).expect(403);
    });

    it('lets matching tokens and safe methods through', async () => {
      await request(app)
        .post('/x')
        .set({ Cookie: cookie, [CSRF_HEADER]: 'expected-token' })
        .expect(200);
      await request(app).get('/x').expect(200);
    });
  });

  describe('with real sessions', () => {
    let db: TestDatabase;
    let app: ReturnType<typeof createTestApp>['app'];
    let mine: SignedIn;
    let theirs: SignedIn;

    beforeAll(async () => {
      db = await createTestDatabase();
      const testApp = createTestApp({ pool: db.pool, signedIn: false });
      app = testApp.app;
      mine = await createSignedInSession(testApp.deps.config, db.pool);
      theirs = await createSignedInSession(testApp.deps.config, db.pool);
    });
    afterAll(() => db.cleanup());

    it("refuses another session's CSRF token, even when cookie and header agree", async () => {
      const res = await request(app)
        .post('/api/tokens')
        .set('Cookie', `${SESSION_COOKIE}=${mine.token}; ${CSRF_COOKIE}=${theirs.csrf}`)
        .set(CSRF_HEADER, theirs.csrf)
        .send({ label: 'forged' });
      expect(res.status).toBe(403);
      const { rows } = await db.pool.query('SELECT 1 FROM ingest_tokens');
      expect(rows).toHaveLength(0);
    });

    it('accepts the session’s own token', async () => {
      await request(app).post('/api/tokens').set(mine.headers).send({ label: 'ok' }).expect(201);
    });
  });
});
