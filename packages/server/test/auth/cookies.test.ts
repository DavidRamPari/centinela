/**
 * Cookie modes (S8): `__Host-` cookies with `Secure` over HTTPS and always in production;
 * unprefixed cookies without `Secure` only for plain-HTTP development on localhost, where
 * WebKit (Safari) refuses `Secure` cookies. Each mode reads only its own names.
 */
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  LOCAL_CSRF_COOKIE,
  LOCAL_SESSION_COOKIE,
  SESSION_COOKIE,
} from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST_COOKIES, LOCAL_COOKIES, isLoopbackHost } from '../../src/security/cookies.js';
import { createTestApp } from '../helpers/app.js';
import {
  TEST_PASSWORD,
  TEST_USERNAME,
  productionTestEnv,
  setCookies,
  signIn,
} from '../helpers/auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

type App = ReturnType<typeof createTestApp>['app'];
const CREDENTIALS = { username: TEST_USERNAME, password: TEST_PASSWORD };

function login(app: App, headers: Record<string, string>) {
  return request(app).post('/api/auth/login').set(headers).send(CREDENTIALS).expect(200);
}

/** Names of the cookies a response sets (not the ones it clears). */
function setNames(res: request.Response): string[] {
  return [...setCookies(res)].filter(([, cookie]) => cookie.value !== '').map(([name]) => name);
}

function expectHostCookies(res: request.Response): void {
  const cookies = setCookies(res);
  expect(setNames(res).sort()).toEqual([CSRF_COOKIE, SESSION_COOKIE].sort());
  expect(cookies.get(SESSION_COOKIE)?.attributes).toEqual(
    expect.arrayContaining(['secure', 'httponly', 'samesite=strict', 'path=/']),
  );
  expect(cookies.get(CSRF_COOKIE)?.attributes).toEqual(
    expect.arrayContaining(['secure', 'samesite=strict', 'path=/']),
  );
  expect(cookies.get(CSRF_COOKIE)?.attributes).not.toContain('httponly');
}

function expectLocalCookies(res: request.Response): void {
  const cookies = setCookies(res);
  expect(setNames(res).sort()).toEqual([LOCAL_CSRF_COOKIE, LOCAL_SESSION_COOKIE].sort());
  const session = cookies.get(LOCAL_SESSION_COOKIE)?.attributes ?? [];
  const csrf = cookies.get(LOCAL_CSRF_COOKIE)?.attributes ?? [];
  expect(session).toEqual(
    expect.arrayContaining(['httponly', 'samesite=strict', 'path=/', 'max-age=43200']),
  );
  expect(csrf).toEqual(expect.arrayContaining(['samesite=strict', 'path=/', 'max-age=43200']));
  expect(csrf).not.toContain('httponly');
  for (const attributes of [session, csrf]) {
    expect(attributes).not.toContain('secure');
    expect(attributes.some((a) => a.startsWith('domain='))).toBe(false);
  }
}

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.8.9.10', '[::1]', '::1'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    '192.168.1.10',
    '10.0.0.1',
    '128.0.0.1',
    '0.0.0.0',
    '[::2]',
    'centinela.example.org',
    'localhost.example.org',
    '127.0.0.1.nip.io',
    '',
    undefined,
  ])('refuses %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('cookie modes', () => {
  let db: TestDatabase;
  let dev: App;
  let behindProxy: App;
  let production: App;

  beforeAll(async () => {
    db = await createTestDatabase();
    dev = createTestApp({ pool: db.pool, signedIn: false }).app;
    behindProxy = createTestApp({
      pool: db.pool,
      signedIn: false,
      env: { TRUST_PROXY: 'loopback' },
    }).app;
    production = createTestApp({
      pool: db.pool,
      signedIn: false,
      env: await productionTestEnv(),
    }).app;
  });
  afterAll(() => db.cleanup());

  describe('development over plain HTTP on localhost', () => {
    it.each(['localhost:8080', 'localhost:5173', '127.0.0.1:3000', '[::1]:8080'])(
      'uses unprefixed cookies without Secure for Host %s',
      async (host) => {
        expectLocalCookies(await login(dev, { Host: host }));
      },
    );

    it('works end to end: session, CSRF re-issue, a state-changing request, sign-out', async () => {
      const session = await signIn(dev);
      expect(session.names).toBe(LOCAL_COOKIES);

      const me = await request(dev).get('/api/auth/me').set('Cookie', session.cookie).expect(200);
      expect(setCookies(me).get(LOCAL_CSRF_COOKIE)?.value).toBe(session.csrf);
      expect(setCookies(me).has(CSRF_COOKIE)).toBe(false);

      await request(dev).post('/api/tokens').set(session.headers).send({ label: 'l' }).expect(201);
      // The double submit reads the local CSRF cookie: the same value under the
      // `__Host-` name does not count in this mode.
      await request(dev)
        .post('/api/tokens')
        .set('Cookie', `${LOCAL_SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`)
        .set(CSRF_HEADER, session.csrf)
        .send({ label: 'l' })
        .expect(403);

      const out = await request(dev).post('/api/auth/logout').set(session.headers).expect(204);
      const cleared = setCookies(out);
      for (const name of [LOCAL_SESSION_COOKIE, LOCAL_CSRF_COOKIE]) {
        expect(cleared.get(name)?.value).toBe('');
        expect(cleared.get(name)?.attributes).not.toContain('secure');
      }
      expect(cleared.has(SESSION_COOKIE)).toBe(false);
    });

    it('does not read a __Host- session cookie', async () => {
      const session = await signIn(dev, { https: true });
      expect(session.names).toBe(HOST_COOKIES);
      await request(dev).get('/api/auth/me').set('Cookie', session.cookie).expect(401);
    });

    it('clears __Host- cookies left by an HTTPS session at sign-in', async () => {
      const res = await login(dev, {
        Cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}; ${CSRF_COOKIE}=old`,
      });
      expectLocalCookies(res);
      const cleared = setCookies(res);
      for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
        expect(cleared.get(name)?.value).toBe('');
        // Cleared with the attributes they were set with, or the browser ignores it.
        expect(cleared.get(name)?.attributes).toEqual(
          expect.arrayContaining(['secure', 'path=/', 'samesite=strict']),
        );
      }
    });
  });

  describe('HTTPS', () => {
    it('uses __Host- cookies with Secure behind a trusted TLS proxy', async () => {
      expectHostCookies(
        await login(behindProxy, { Host: 'localhost:8080', 'X-Forwarded-Proto': 'https' }),
      );
    });

    it('uses __Host- cookies when an untrusted X-Forwarded-Proto says https', async () => {
      // Without TRUST_PROXY the header is still believed: it can only make cookies stricter.
      expectHostCookies(await login(dev, { Host: 'localhost', 'X-Forwarded-Proto': 'https' }));
      expectHostCookies(
        await login(dev, { Host: 'localhost', 'X-Forwarded-Proto': 'http, https' }),
      );
    });

    it('never reads the unprefixed cookies', async () => {
      const local = await signIn(dev);
      await request(dev)
        .get('/api/auth/me')
        .set('Cookie', local.cookie)
        .set('X-Forwarded-Proto', 'https')
        .expect(401);
    });

    it('clears unprefixed cookies left by a plain-HTTP session at sign-in', async () => {
      const res = await login(dev, {
        'X-Forwarded-Proto': 'https',
        Cookie: `${LOCAL_SESSION_COOKIE}=x; ${LOCAL_CSRF_COOKIE}=y`,
      });
      expectHostCookies(res);
      for (const name of [LOCAL_SESSION_COOKIE, LOCAL_CSRF_COOKIE]) {
        expect(setCookies(res).get(name)?.value).toBe('');
      }
    });
  });

  it.each(['192.168.1.10:8080', 'centinela.example.org'])(
    'keeps __Host- cookies for plain HTTP to another host (%s)',
    async (host) => {
      expectHostCookies(await login(dev, { Host: host }));
    },
  );

  describe('production', () => {
    it.each(['localhost:8080', '127.0.0.1'])(
      'always uses __Host- cookies with Secure, even over plain HTTP to %s',
      async (host) => {
        expectHostCookies(await login(production, { Host: host }));
      },
    );

    it('never reads the unprefixed cookies', async () => {
      const session = await signIn(production);
      expect(session.names).toBe(HOST_COOKIES);
      await request(production).get('/api/auth/me').set('Cookie', session.cookie).expect(200);
      const renamed = `${LOCAL_SESSION_COOKIE}=${session.token}; ${LOCAL_CSRF_COOKIE}=${session.csrf}`;
      await request(production).get('/api/auth/me').set('Cookie', renamed).expect(401);
    });
  });
});
