import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const API_CSP = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

describe('API security headers', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let anonymous: ReturnType<typeof createTestApp>['app'];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
    ({ app: anonymous } = createTestApp({ pool: db.pool, signedIn: false }));
  });
  afterAll(() => db.cleanup());

  it.each([
    ['a JSON answer', () => request(app).get('/api/alerts'), 200],
    ['a 401 problem', () => request(anonymous).get('/api/alerts'), 401],
    ['a 404 outside /api', () => request(anonymous).get('/index.html'), 404],
    ['the health check', () => request(anonymous).get('/api/health'), 200],
  ])('are set on %s', async (_label, send, status) => {
    const res = await send();
    expect(res.status).toBe(status);
    expect(res.headers['content-security-policy']).toBe(API_CSP);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
