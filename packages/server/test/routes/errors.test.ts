import { problemSchema } from '@centinela/shared';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createErrorHandler } from '../../src/http/errors.js';
import { HttpError } from '../../src/http/problem.js';
import { validate } from '../../src/http/validate.js';
import { createLogger } from '../../src/logger.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('problem+json errors', () => {
  // Signed in (S6): the session guard runs before routing and body parsing.
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
  });
  afterAll(() => db.cleanup());

  it('answers 404 problem+json for unknown routes', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemSchema.parse(res.body)).toMatchObject({ status: 404, title: 'Not Found' });
  });

  it('answers 400 for malformed JSON bodies', async () => {
    const res = await request(app)
      .patch('/api/alerts/01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f')
      .set('Content-Type', 'application/json')
      .send('{"status": ')
      .expect(400);
    expect(problemSchema.parse(res.body).detail).toBe('Request body is not valid JSON');
  });

  it('answers 413 for JSON bodies above the limit', async () => {
    const res = await request(app)
      .post('/api/alerts/bulk')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(200_000) }))
      .expect(413);
    expect(problemSchema.parse(res.body).status).toBe(413);
  });

  describe('error handler', () => {
    const logger = createLogger({ logLevel: 'silent' });
    const errorApp = express();
    errorApp.get('/http-error', () => {
      throw new HttpError(409, 'Already closed');
    });
    errorApp.get('/validation', (req) => {
      validate(z.object({ limit: z.coerce.number().max(10) }), req.query, 'query');
    });
    errorApp.get('/crash', () => {
      throw new Error('database password is hunter2');
    });
    errorApp.use(createErrorHandler(logger));

    it('renders HttpError with its status and detail', async () => {
      const res = await request(errorApp).get('/http-error').expect(409);
      expect(res.body).toEqual({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Already closed',
      });
    });

    it('renders validation errors with field paths', async () => {
      const res = await request(errorApp).get('/validation?limit=500').expect(400);
      const body = problemSchema.parse(res.body);
      expect(body.detail).toBe('Invalid query');
      expect(body.errors?.[0]?.path).toBe('limit');
    });

    it('hides internal error messages behind a generic 500', async () => {
      const res = await request(errorApp).get('/crash').expect(500);
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      expect(problemSchema.parse(res.body).title).toBe('Internal Server Error');
    });
  });
});
