/**
 * Signing in for API tests. `signIn` goes through `POST /api/auth/login` like the dashboard;
 * `createSignedInSession` writes a session row directly (for the app helper). Both return
 * the headers a browser would send: the two cookies and the CSRF header. supertest's agent
 * would not send `Secure` cookies over plain HTTP, so tests set the headers by hand.
 *
 * supertest talks plain HTTP to 127.0.0.1, so outside production the server answers with the
 * local cookie names (`cookieMode`); a request that says `X-Forwarded-Proto: https`, or any
 * request to a production app, gets the `__Host-` names.
 */
import { CSRF_HEADER, SESSION_COOKIE } from '@centinela/shared';
import argon2 from 'argon2';
import type { Pool } from 'pg';
import request from 'supertest';
import { sessionStoreFor } from '../../src/auth/index.js';
import type { Config } from '../../src/config.js';
import { HOST_COOKIES, LOCAL_COOKIES, type CookieMode } from '../../src/security/cookies.js';
import { csrfTokenFor } from '../../src/security/csrf.js';

/** Credentials of the test admin (`createTestApp` configures them). */
export const TEST_USERNAME = 'analyst';
export const TEST_PASSWORD = 'test-password-for-centinela';
/** Cheap argon2id parameters so each sign-in takes milliseconds in tests. */
export const TEST_PASSWORD_HASH = await argon2.hash(TEST_PASSWORD, {
  type: argon2.argon2id,
  memoryCost: 1024,
  timeCost: 1,
  parallelism: 1,
});

export interface SignedIn {
  token: string;
  csrf: string;
  /** The cookie names the server uses for these requests. */
  names: CookieMode;
  /** `Cookie` header with both cookies. */
  cookie: string;
  /** Headers for a state-changing request: `Cookie` and `X-CSRF-Token`. */
  headers: Record<string, string>;
}

export function signedInHeaders(
  token: string,
  csrf: string,
  names: CookieMode = LOCAL_COOKIES,
): SignedIn {
  const cookie = `${names.session}=${token}; ${names.csrf}=${csrf}`;
  return { token, csrf, names, cookie, headers: { Cookie: cookie, [CSRF_HEADER]: csrf } };
}

/** The cookie names a plain-HTTP test request to an app with `config` uses. */
export function testCookieMode(config: Config): CookieMode {
  return config.isProduction ? HOST_COOKIES : LOCAL_COOKIES;
}

export async function createSignedInSession(config: Config, pool: Pool): Promise<SignedIn> {
  const { token } = await sessionStoreFor(config, pool).create({
    username: config.admin.username,
    ip: null,
    userAgent: 'vitest',
  });
  return signedInHeaders(token, csrfTokenFor(config.sessionSecret, token), testCookieMode(config));
}

/** Parsed `Set-Cookie` headers of a response, by cookie name. */
export function setCookies(
  res: request.Response,
): Map<string, { value: string; attributes: string[] }> {
  const raw = res.headers['set-cookie'] as unknown;
  const lines = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const cookies = new Map<string, { value: string; attributes: string[] }>();
  for (const line of lines) {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), {
      value: decodeURIComponent(pair.slice(separator + 1)),
      attributes: attributes.map((attribute) => attribute.toLowerCase()),
    });
  }
  return cookies;
}

/**
 * Sign in through the API; throws unless the login succeeds. `https` sends
 * `X-Forwarded-Proto: https`, as a TLS-terminating proxy would.
 */
export async function signIn(
  app: Parameters<typeof request>[0],
  options: { username?: string; password?: string; https?: boolean } = {},
): Promise<SignedIn> {
  const req = request(app).post('/api/auth/login');
  if (options.https) req.set('X-Forwarded-Proto', 'https');
  const res = await req
    .send({
      username: options.username ?? TEST_USERNAME,
      password: options.password ?? TEST_PASSWORD,
    })
    .expect(200);
  const cookies = setCookies(res);
  const names = cookies.has(SESSION_COOKIE) ? HOST_COOKIES : LOCAL_COOKIES;
  const token = cookies.get(names.session)?.value;
  const csrf = cookies.get(names.csrf)?.value;
  if (!token || !csrf) throw new Error('login did not set both cookies');
  return signedInHeaders(token, csrf, names);
}

let productionHash: Promise<string> | undefined;

/**
 * Environment for a production-mode app: strong secrets and a hash of `TEST_PASSWORD` with
 * the minimum argon2id cost production accepts.
 */
export async function productionTestEnv(): Promise<Record<string, string>> {
  productionHash ??= argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  return {
    NODE_ENV: 'production',
    INGEST_TOKEN: 'prod-token-0123456789abcdef0123456789',
    DATABASE_URL: 'postgres://centinela:not-the-dev-password@localhost:5432/centinela',
    ADMIN_USERNAME: TEST_USERNAME,
    ADMIN_PASSWORD_HASH: await productionHash,
    SESSION_SECRET: 'production-session-secret-0123456789abcdef',
  };
}
