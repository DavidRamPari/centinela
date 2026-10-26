import { healthResponseSchema } from '@centinela/shared';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('GET /api/health', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  it('returns 200 when the database is up', async () => {
    const { app } = createTestApp({ pool: db.pool });
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(healthResponseSchema.parse(res.body).version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 503 when the database is unreachable', async () => {
    // Port 1 on localhost refuses connections immediately.
    const unreachable = new pg.Pool({
      connectionString: 'postgres://centinela:centinela@127.0.0.1:1/centinela',
      connectionTimeoutMillis: 1_000,
    });
    try {
      const { app } = createTestApp({ pool: unreachable });
      const res = await request(app).get('/api/health').expect(503);
      expect(res.body).toMatchObject({ status: 'degraded', db: 'down' });
    } finally {
      await unreachable.end();
    }
  });

  it('sets security headers (helmet) and hides the framework', async () => {
    const { app } = createTestApp({ pool: db.pool });
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
