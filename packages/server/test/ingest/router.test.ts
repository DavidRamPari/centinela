import { ingestSummarySchema, problemSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { tokensEqual } from '../../src/ingest/auth.js';
import { createTestApp } from '../helpers/app.js';
import { TEST_USERNAME, productionTestEnv, signIn } from '../helpers/auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const AUTH = `Bearer ${DEV_INGEST_TOKEN}`;

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
    it('ingests with the dashboard session and CSRF token, and audits the upload', async () => {
      const res = await request(app)
        .post('/api/ingest/upload?source=linux_auth&host=upload-host')
        .type('text/plain')
        .send('Oct 25 14:03:12 upload-host sshd[1]: Invalid user x from 192.0.2.1 port 1\n')
        .expect(200);
      expect(res.body).toMatchObject({ accepted: 1 });
      expect(await countEvents('upload-host')).toBe(1);
      const { rows } = await db.pool.query<{ actor: string; details: unknown }>(
        `SELECT actor, details FROM audit_log WHERE action = 'ingest.upload'`,
      );
      expect(rows).toEqual([
        {
          actor: TEST_USERNAME,
          details: { source: 'linux_auth', host: 'upload-host', accepted: 1, rejected: 0 },
        },
      ]);
    });

    it('answers 401 without a session and 403 without the CSRF token', async () => {
      const { app: anonymous } = createTestApp({ pool: db.pool, signedIn: false });
      const line = 'Oct 25 14:03:12 anon-host sshd[1]: Invalid user x from 192.0.2.1 port 1';
      expectProblem(
        await request(anonymous)
          .post('/api/ingest/upload?source=linux_auth')
          .type('text/plain')
          .send(line),
        401,
      );
      // A bearer token is not a dashboard session.
      expectProblem(
        await request(anonymous)
          .post('/api/ingest/upload?source=linux_auth')
          .set('Authorization', AUTH)
          .type('text/plain')
          .send(line),
        401,
      );
      const session = await signIn(anonymous);
      expectProblem(
        await request(anonymous)
          .post('/api/ingest/upload?source=linux_auth')
          .set('Cookie', session.cookie)
          .type('text/plain')
          .send(line),
        403,
      );
      expect(await countEvents('anon-host')).toBe(0);
    });

    it('validates the query like /api/ingest', async () => {
      const res = await request(app)
        .post('/api/ingest/upload?source=nope')
        .type('text/plain')
        .send('x');
      expectProblem(res, 400);
    });

    it('works in production behind the session, next to the token endpoint', async () => {
      const env = await productionTestEnv();
      const { app: production } = createTestApp({ pool: db.pool, env, signedIn: false });
      const line = 'Oct 25 14:03:12 prod-host sshd[1]: x';
      expectProblem(
        await request(production)
          .post('/api/ingest/upload?source=linux_auth')
          .type('text/plain')
          .send(line),
        401,
      );
      const session = await signIn(production);
      await request(production)
        .post('/api/ingest/upload?source=linux_auth')
        .set(session.headers)
        .type('text/plain')
        .send(line)
        .expect(200);
      await request(production)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send(line)
        .expect(401);
      await request(production)
        .post('/api/ingest?source=linux_auth')
        .set('Authorization', `Bearer ${env.INGEST_TOKEN}`)
        .type('text/plain')
        .send(line)
        .expect(200);
      expect(await countEvents('prod-host')).toBe(2);
    });
  });

  describe('acknowledgement and streams (S12)', () => {
    // Dated a minute ago plus `second`: newer than anything the earlier tests sent, so
    // these events are not late, and never ahead of the server's clock.
    const started = Date.now() - 60_000;
    const line = (second: number, host: string) =>
      `${new Date(started + second * 100).toISOString()} ${host} sshd[1234]: Failed password for root from 203.0.113.45 port 40000 ssh2`;

    it('ack=stored answers before the events are evaluated and says how many wait', async () => {
      const first = await request(app)
        .post('/api/ingest?source=linux_auth&host=ack-01&ack=stored')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send([line(1, 'ack-01'), line(2, 'ack-01')].join('\n'))
        .expect(200);
      expect(ingestSummarySchema.parse(first.body)).toMatchObject({
        accepted: 2,
        pending: 2,
        late: 0,
        alertsCreated: 0,
      });
      expect(await countEvents('ack-01')).toBe(2);

      // The default waits for evaluation, and takes the older waiting events with it.
      const second = await request(app)
        .post('/api/ingest?source=linux_auth&host=ack-02')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send(line(3, 'ack-02'))
        .expect(200);
      expect(ingestSummarySchema.parse(second.body)).toMatchObject({ accepted: 1, pending: 0 });
    });

    it('answers 400 for an unknown ack mode', async () => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth&ack=later')
        .set('Authorization', AUTH)
        .type('text/plain')
        .send('x');
      expect(expectProblem(res, 400).errors?.[0]?.path).toBe('ack');
    });

    it('an upload always answers with final counts', async () => {
      const res = await request(app)
        .post('/api/ingest/upload?source=linux_auth&host=ack-03&ack=stored')
        .type('text/plain')
        .send(line(30, 'ack-03'))
        .expect(200);
      expect(ingestSummarySchema.parse(res.body)).toMatchObject({ accepted: 1, pending: 0 });
    });

    it('records who delivered: a stream per source and host, stamped on every event', async () => {
      const { rows } = await db.pool.query<{
        kind: string;
        host: string;
        accepted: string;
        n: string;
      }>(
        `SELECT s.kind, s.host, s.accepted,
                (SELECT count(*) FROM events e WHERE e.stream_id = s.id) AS n
           FROM ingest_streams s WHERE s.host LIKE 'ack-%' ORDER BY s.host`,
      );
      expect(rows).toEqual([
        { kind: 'token', host: 'ack-01', accepted: '2', n: '2' },
        { kind: 'token', host: 'ack-02', accepted: '1', n: '1' },
        { kind: 'upload', host: 'ack-03', accepted: '1', n: '1' },
      ]);
      const orphans = await db.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM events WHERE stream_id IS NULL',
      );
      expect(orphans.rows[0]?.n).toBe('0');
    });

    it('answers 403 when the token already delivers for the maximum of sources and hosts', async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ingest_streams WHERE kind = 'token' AND token_id IS NULL`,
      );
      await db.pool.query(
        `INSERT INTO ingest_streams (id, kind, source, host)
         SELECT gen_random_uuid(), 'token', 'linux_auth', 'filler-' || n
           FROM generate_series(1, $1) AS n`,
        [1000 - Number(rows[0]?.n)],
      );
      try {
        const res = await request(app)
          .post('/api/ingest?source=linux_auth&host=one-too-many')
          .set('Authorization', AUTH)
          .type('text/plain')
          .send(line(40, 'one-too-many'));
        expect(expectProblem(res, 403).detail).toContain('1000 source and host pairs');
        expect(await countEvents('one-too-many')).toBe(0);
        // A stream the token already has keeps working.
        await request(app)
          .post('/api/ingest?source=linux_auth&host=ack-01')
          .set('Authorization', AUTH)
          .type('text/plain')
          .send(line(41, 'ack-01'))
          .expect(200);
      } finally {
        await db.pool.query(`DELETE FROM ingest_streams WHERE host LIKE 'filler-%'`);
      }
    });
  });

  describe('rate limiting', () => {
    it('answers 429 problem+json past the configured limits, also for bad tokens', async () => {
      const { app: limited } = createTestApp({
        pool: db.pool,
        env: { RATE_LIMIT_INGEST_PER_MINUTE: '2', RATE_LIMIT_UPLOAD_PER_MINUTE: '1' },
      });

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
