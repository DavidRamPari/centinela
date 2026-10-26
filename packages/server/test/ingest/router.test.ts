import { ingestSummarySchema, problemSchema } from '@centinela/shared';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { createErrorHandler } from '../../src/http/errors.js';
import { tokensEqual } from '../../src/ingest/auth.js';
import { createIngestRouter } from '../../src/ingest/router.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const AUTH = `Bearer ${DEV_INGEST_TOKEN}`;
const PRODUCTION_TOKEN = 'prod-token-0123456789abcdef0123456789';
const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  INGEST_TOKEN: PRODUCTION_TOKEN,
  DATABASE_URL: 'postgres://centinela:not-the-dev-password@localhost:5432/centinela',
};

const AUTH_LINES = [
  'Oct 25 14:03:12 bastion-01 sshd[1234]: Failed password for root from 203.0.113.45 port 40000 ssh2',
  'this is not syslog',
  'Oct 25 14:03:13 bastion-01 sshd[1234]: Accepted password for deploy from 203.0.113.77 port 40001 ssh2',
  '',
  'Oct 25 14:03:14 bastion-01 CRON[1]: (root) CMD (true)',
];

function expectProblem(res: request.Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  return problemSchema.parse(res.body);
}

describe('POST /api/ingest and /api/ingest/upload', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];

  async function countEvents(host: string): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*) FROM events WHERE host = $1',
      [host],
    );
    return Number(rows[0]?.count);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
  });
  afterAll(() => db.cleanup());

  describe('authentication', () => {
    it('answers 401 without a token', async () => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth')
        .type('text/plain')
        .send(AUTH_LINES.join('\n'));
      expectProblem(res, 401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    });

    it.each([
      ['a wrong token', 'Bearer wrong-token'],
      ['a token with a suffix', `${AUTH}x`],
      ['another scheme', `Basic ${Buffer.from(`x:${DEV_INGEST_TOKEN}`).toString('base64')}`],
      ['an empty bearer', 'Bearer '],
    ])('answers 401 with %s', async (_name, header) => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', header)
        .type('text/plain')
        .send('x');
      expectProblem(res, 401);
    });

    it('stores nothing for an unauthenticated request', async () => {
      await request(app)
        .post('/api/ingest?source=linux_auth&host=unauth-host')
        .type('text/plain')
        .send('Oct 25 14:03:12 unauth-host sshd[1]: x')
        .expect(401);
      expect(await countEvents('unauth-host')).toBe(0);
    });

    it('compares tokens in constant time over equal-length digests', () => {
      expect(tokensEqual('abc', 'abc')).toBe(true);
      expect(tokensEqual('abc', 'abcd')).toBe(false);
      expect(tokensEqual('', 'abc')).toBe(false);
    });
  });

  describe('validation', () => {
    it.each([
      ['an unknown source', 'source=windows_eventlog'],
      ['a missing source', 'host=a'],
      ['an invalid host', 'source=linux_auth&host=a%20b'],
      ['an unknown time zone', 'source=linux_auth&tz=Mars%2FOlympus'],
      ['a repeated source', 'source=linux_auth&source=nginx_access'],
    ])('answers 400 for %s', async (_name, query) => {
      const res = await request(app)
        .post(`/api/ingest?${query}`)
        .set('Authorization', AUTH)
        .type('text/plain')
        .send('x');
      const body = expectProblem(res, 400);
      expect(body.errors?.length).toBeGreaterThan(0);
    });

    it('answers 413 for a body over 5 MB', async () => {
      const line = 'Oct 25 14:03:12 h sshd[1]: x'.padEnd(1023, 'x');
      const body = `${line}\n`.repeat(5 * 1024 + 1);
      const res = await request(app)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send(body);
      expectProblem(res, 413);
    });

    it('answers 415 for other content types', async () => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', AUTH)
        .type('application/json')
        .send(JSON.stringify({ line: 'x' }));
      expectProblem(res, 415);
    });
  });

  describe('ingestion', () => {
    it('parses text lines, stores accepted events and reports rejections', async () => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth&host=ignored&tz=America%2FLima')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send(AUTH_LINES.join('\r\n'))
        .expect(200);
      const summary = ingestSummarySchema.parse(res.body);
      expect(summary).toMatchObject({
        accepted: 3,
        rejected: 1,
        rejections: [{ line: 2, reason: 'not a syslog line' }],
      });
      expect(await countEvents('bastion-01')).toBe(3);
      const { rows } = await db.pool.query<{ ts: Date; action: string }>(
        "SELECT ts, action FROM events WHERE host = 'bastion-01' ORDER BY ts",
      );
      expect(rows.map((r) => r.action)).toEqual(['ssh_login', 'ssh_login', 'other']);
      // RFC 3164 time read in America/Lima (UTC−05:00).
      expect(rows[0]?.ts.toISOString()).toMatch(/T19:03:12\.000Z$/);
    });

    it('uses the host parameter for web access logs', async () => {
      const res = await request(app)
        .post('/api/ingest?source=nginx_access&host=web-07')
        .set('Authorization', AUTH)
        .type('text/plain; charset=utf-8')
        .send(
          '192.0.2.10 - - [25/Oct/2026:14:03:12 -0500] "GET /?q=%27 HTTP/1.1" 404 153 "-" "sqlmap/1.8"\n',
        )
        .expect(200);
      expect(res.body).toMatchObject({ accepted: 1, rejected: 0 });
      expect(await countEvents('web-07')).toBe(1);
    });

    it('accepts NDJSON and merges its rejections in line order', async () => {
      const body = [
        JSON.stringify(
          '192.0.2.10 - - [25/Oct/2026:14:03:12 -0500] "GET / HTTP/1.1" 200 1 "-" "-"',
        ),
        '{oops',
        JSON.stringify({
          message: '192.0.2.11 - - [25/Oct/2026:14:03:13 -0500] "GET / HTTP/1.1" 200 1 "-" "-"',
        }),
        JSON.stringify('not an access log line'),
      ].join('\n');
      const res = await request(app)
        .post('/api/ingest?source=nginx_access&host=web-ndjson')
        .set('Authorization', AUTH)
        .type('application/x-ndjson')
        .send(body)
        .expect(200);
      expect(res.body).toMatchObject({
        accepted: 2,
        rejected: 2,
        rejections: [
          { line: 2, reason: 'invalid NDJSON line' },
          { line: 4, reason: 'not an access log line' },
        ],
      });
      expect(await countEvents('web-ndjson')).toBe(2);
    });

    it('caps rejection samples at 20', async () => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send(Array.from({ length: 30 }, () => 'garbage').join('\n'))
        .expect(200);
      expect(res.body).toMatchObject({ accepted: 0, rejected: 30 });
      expect((res.body as { rejections: unknown[] }).rejections).toHaveLength(20);
    });

    it('accepts an empty body', async () => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send('')
        .expect(200);
      expect(res.body).toMatchObject({ accepted: 0, rejected: 0 });
    });
  });

  describe('upload', () => {
    it('ingests without a token outside production', async () => {
      const res = await request(app)
        .post('/api/ingest/upload?source=linux_auth')
        .type('text/plain')
        .send('Oct 25 14:03:12 upload-host sshd[1]: Invalid user x from 192.0.2.1 port 1\n')
        .expect(200);
      expect(res.body).toMatchObject({ accepted: 1 });
      expect(await countEvents('upload-host')).toBe(1);
    });

    it('validates the query like /api/ingest', async () => {
      const res = await request(app)
        .post('/api/ingest/upload?source=nope')
        .type('text/plain')
        .send('x');
      expectProblem(res, 400);
    });

    it('answers 404 in production, while the token endpoint keeps working', async () => {
      const { app: production } = createTestApp({ pool: db.pool, env: PRODUCTION_ENV });
      const upload = await request(production)
        .post('/api/ingest/upload?source=linux_auth')
        .type('text/plain')
        .send('Oct 25 14:03:12 prod-host sshd[1]: x');
      expectProblem(upload, 404);
      await request(production)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send('Oct 25 14:03:12 prod-host sshd[1]: x')
        .expect(401);
      await request(production)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', `Bearer ${PRODUCTION_TOKEN}`)
        .type('text/plain')
        .send('Oct 25 14:03:12 prod-host sshd[1]: x')
        .expect(200);
      expect(await countEvents('prod-host')).toBe(1);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 problem+json past the limit, also for bad tokens', async () => {
      const { deps } = createTestApp({ pool: db.pool });
      const limited = express();
      limited.use(
        '/api',
        createIngestRouter(deps, {
          ingestRateLimit: { windowMs: 60_000, limit: 2 },
          uploadRateLimit: { windowMs: 60_000, limit: 1 },
        }),
      );
      limited.use(createErrorHandler(deps.logger));

      const send = (auth: string) =>
        request(limited)
          .post('/api/ingest?source=linux_auth')
          .set('Authorization', auth)
          .type('text/plain')
          .send('');
      await send(AUTH).expect(200);
      await send('Bearer wrong').expect(401);
      const res = await send(AUTH);
      expectProblem(res, 429);
      expect(res.headers['ratelimit-policy']).toBeDefined();

      const upload = () =>
        request(limited).post('/api/ingest/upload?source=linux_auth').type('text/plain').send('');
      await upload().expect(200);
      expectProblem(await upload(), 429);
    });
  });
});
