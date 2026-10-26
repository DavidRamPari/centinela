import { problemSchema } from '@centinela/shared';
import pg from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';

// Every endpoint in ARCHITECTURE §9 except health and the two ingest endpoints.
// A session that implements an endpoint deletes its row here.
const pending: Array<{ method: 'get' | 'post' | 'patch'; path: string; session: string }> = [
  { method: 'post', path: '/api/auth/login', session: 'S6' },
  { method: 'post', path: '/api/auth/logout', session: 'S6' },
  { method: 'get', path: '/api/auth/me', session: 'S6' },
];

describe('endpoints not implemented yet', () => {
  // These routes never touch the database; the pool is never connected.
  const pool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });
  afterAll(() => pool.end());
  const { app } = createTestApp({ pool });

  it.each(pending)(
    '$method $path answers 501 problem+json ($session)',
    async ({ method, path, session }) => {
      const res = await request(app)[method](path).expect(501);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      const body = problemSchema.parse(res.body);
      expect(body).toMatchObject({ type: 'about:blank', title: 'Not Implemented', status: 501 });
      expect(body.detail).toContain(`session ${session}`);
      expect(body.detail).toContain(`${method.toUpperCase()} /api/`);
    },
  );
});
