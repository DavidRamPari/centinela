import { problemSchema } from '@centinela/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createNotImplementedRouter, pendingEndpoints } from '../../src/routes/not-implemented.js';

// S6 and S7 implemented the last stubs of ARCHITECTURE §9; the stub router stays for
// endpoints added to the contract before their session implements them.
describe('endpoints not implemented yet', () => {
  it('has no pending endpoint left', () => {
    expect(pendingEndpoints).toEqual([]);
  });

  it('answers 501 problem+json naming the endpoint and its session', async () => {
    const app = express().use(
      '/api',
      createNotImplementedRouter([{ method: 'get', path: '/future', session: 'S9' }]),
    );
    const res = await request(app).get('/api/future').expect(501);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const body = problemSchema.parse(res.body);
    expect(body).toMatchObject({ type: 'about:blank', title: 'Not Implemented', status: 501 });
    expect(body.detail).toBe('GET /api/future is implemented in session S9');
  });
});
