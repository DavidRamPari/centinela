/**
 * The bearer check of `/api/ingest` and the count, per client address, of requests
 * without a valid token (ARCHITECTURE §9, check 1; S11 review, S11-R03). Checking a stored
 * token takes a database round trip, so guesses sent at once must be counted while they
 * are checked, not after.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CONFIG_TOKEN_CREDENTIAL, type IngestCredential } from '../../src/auth/ingest-tokens.js';
import { loadConfig } from '../../src/config.js';
import { createErrorHandler } from '../../src/http/errors.js';
import { requireBearerToken } from '../../src/ingest/auth.js';
import { createLogger } from '../../src/logger.js';
import { createWindowCounter } from '../../src/security/rate-limit.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The bearer check alone, with a token check that answers when the test lets it. */
function setup(limit: number) {
  let checked = 0;
  let waiting: Array<() => void> = [];
  let held = true;
  const verify = async (token: string): Promise<IngestCredential | null> => {
    checked += 1;
    if (held) await new Promise<void>((resolve) => waiting.push(resolve));
    return token === 'right-token' ? CONFIG_TOKEN_CREDENTIAL : null;
  };
  const app = express();
  app.post(
    '/ingest',
    requireBearerToken(verify, createWindowCounter({ windowMs: 60_000, limit })),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.use(createErrorHandler(logger));
  return {
    app,
    checked: () => checked,
    release: () => {
      held = false;
      const now = waiting;
      waiting = [];
      for (const resolve of now) resolve();
    },
  };
}

describe('requests without a valid token, per address', () => {
  it('counts a guess while its token is checked, so guesses sent at once stop at the limit', async () => {
    const { app, checked, release } = setup(3);
    let answered = 0;
    const statuses = Array.from({ length: 12 }, (_, i) =>
      request(app)
        .post('/ingest')
        .set('Authorization', `Bearer guess-${i}`)
        .then((res) => {
          answered += 1;
          return res.status;
        }),
    );
    // Every guess is either being checked or already refused.
    await until(() => checked() + answered === 12, 'every guess to arrive');
    expect(checked()).toBe(3);
    release();
    const counts = (await Promise.all(statuses)).reduce<Record<number, number>>(
      (acc, status) => ({ ...acc, [status]: (acc[status] ?? 0) + 1 }),
      {},
    );
    expect(counts).toEqual({ 401: 3, 429: 9 });
  });

  it('gives the count back for a valid token, so a shipper never uses up the budget', async () => {
    const { app, release } = setup(2);
    release();
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/ingest').set('Authorization', 'Bearer right-token').expect(200);
    }
    await request(app).post('/ingest').set('Authorization', 'Bearer wrong-1').expect(401);
    await request(app).post('/ingest').set('Authorization', 'Bearer wrong-2').expect(401);
    await request(app).post('/ingest').set('Authorization', 'Bearer right-token').expect(429);
  });

  it('does not count a request whose token could not be checked (a database error)', async () => {
    const app = express();
    let failing = true;
    const verify = (): Promise<IngestCredential | null> =>
      failing ? Promise.reject(new Error('database down')) : Promise.resolve(null);
    app.post(
      '/ingest',
      requireBearerToken(verify, createWindowCounter({ windowMs: 60_000, limit: 1 })),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.use(createErrorHandler(logger));
    await request(app).post('/ingest').set('Authorization', 'Bearer any').expect(500);
    await request(app).post('/ingest').set('Authorization', 'Bearer any').expect(500);
    failing = false;
    await request(app).post('/ingest').set('Authorization', 'Bearer any').expect(401);
    await request(app).post('/ingest').set('Authorization', 'Bearer any').expect(429);
  });
});
