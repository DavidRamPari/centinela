/**
 * Every endpoint of the API contract (ARCHITECTURE §9) except the three public ones answers
 * `401` without a dashboard session, and every state-changing one answers `403` without
 * the CSRF header. The endpoint list is read from ARCHITECTURE.md, so an endpoint added to
 * the contract is covered here without editing this file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_COOKIE, problemSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { repoRoot } from '../../src/paths.js';
import { createTestApp } from '../helpers/app.js';
import { createSignedInSession, type SignedIn } from '../helpers/auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const PUBLIC = new Set(['GET /api/health', 'POST /api/ingest', 'POST /api/auth/login']);
const SAMPLE_ID = '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

/** `METHOD /api/...` entries in the §9 table. */
function contractEndpoints(): Array<{ method: Method; path: string; label: string }> {
  const doc = readFileSync(join(repoRoot, 'docs/ARCHITECTURE.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 9. HTTP API'), doc.indexOf('## 10.'));
  const seen = new Map<string, { method: Method; path: string; label: string }>();
  for (const match of section.matchAll(/`(GET|POST|PATCH|PUT|DELETE) (\/api\/[^`\s]+)`/g)) {
    const label = `${match[1]} ${match[2]}`;
    const method = (match[1] ?? 'GET').toLowerCase() as Method;
    seen.set(label, { method, path: (match[2] ?? '').replaceAll(':id', SAMPLE_ID), label });
  }
  return [...seen.values()];
}

const endpoints = contractEndpoints();
const protectedEndpoints = endpoints.filter((e) => !PUBLIC.has(e.label));
const stateChanging = protectedEndpoints.filter((e) => e.method !== 'get');

function expectProblem(res: request.Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  return problemSchema.parse(res.body);
}

describe('protected routes', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let session: SignedIn;

  beforeAll(async () => {
    db = await createTestDatabase();
    const testApp = createTestApp({ pool: db.pool, signedIn: false });
    app = testApp.app;
    session = await createSignedInSession(testApp.deps.config, db.pool);
  });
  afterAll(() => db.cleanup());

  it('reads the whole contract', () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(22);
    expect(protectedEndpoints.map((e) => e.label)).toEqual(
      expect.arrayContaining([
        'GET /api/events',
        'PATCH /api/alerts/:id',
        'POST /api/ingest/upload',
        'GET /api/stream',
        'GET /api/auth/me',
        'POST /api/auth/logout',
        'GET /api/audit',
      ]),
    );
    expect(PUBLIC.size).toBe(endpoints.filter((e) => PUBLIC.has(e.label)).length);
  });

  it.each(protectedEndpoints)('$label answers 401 without a session', async ({ method, path }) => {
    const res = await request(app)[method](path).set('Content-Type', 'application/json').send('{}');
    expect(expectProblem(res, 401).detail).toBe('Sign in to continue');
  });

  it.each(protectedEndpoints)(
    '$label answers 401 with an unknown session',
    async ({ method, path }) => {
      const unknown = `${SESSION_COOKIE}=${'x'.repeat(43)}`;
      const res = await request(app)[method](path).set('Cookie', unknown);
      expectProblem(res, 401);
    },
  );

  it.each(stateChanging)('$label answers 403 without the CSRF header', async ({ method, path }) => {
    const res = await request(app)[method](path).set('Cookie', session.cookie).send({});
    expect(expectProblem(res, 403).detail).toBe('A valid CSRF token is required');
  });

  it('keeps the public endpoints public', async () => {
    await request(app).get('/api/health').expect(200);
    // The ingest endpoint uses its bearer token, not the session.
    const ingest = await request(app)
      .post('/api/ingest?source=linux_auth')
      .type('text/plain')
      .send('x');
    expectProblem(ingest, 401);
    expect(ingest.headers['www-authenticate']).toMatch(/^Bearer/);
    await request(app)
      .post('/api/ingest?source=linux_auth')
      .set('Authorization', `Bearer ${DEV_INGEST_TOKEN}`)
      .type('text/plain')
      .send('')
      .expect(200);
    expectProblem(await request(app).post('/api/auth/login').send({}), 400);
  });

  it('refuses unknown routes without a session as 401, not 404', async () => {
    expectProblem(await request(app).get('/api/does-not-exist'), 401);
    await request(app).get('/api/does-not-exist').set('Cookie', session.cookie).expect(404);
  });
});
