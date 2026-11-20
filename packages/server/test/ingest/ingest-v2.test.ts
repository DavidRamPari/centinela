/**
 * Ingest v2 (S11, ARCHITECTURE §9): gzip bodies, NDJSON by the parser's input kind, scoped
 * tokens, limits per token and per address, and the bound on requests in progress.
 */
import { request as httpRequest, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { ingestSummarySchema, ingestTokenCreatedSchema, problemSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { BUSY_RETRY_AFTER_SECONDS } from '../../src/ingest/router.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const AUTH = `Bearer ${DEV_INGEST_TOKEN}`;

/** An auth.log line dated a minute ago, so it is evaluated like a live one. */
function authLine(host: string, n = 0): string {
  const at = new Date(Date.now() - 60_000 + n * 1000);
  const month = at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = String(at.getUTCDate()).padStart(2, ' ');
  const time = at.toISOString().slice(11, 19);
  return `${month} ${day} ${time} ${host} sshd[1]: Failed password for root from 203.0.113.45 port 4${n} ssh2`;
}

function expectProblem(
  res: { status: number; headers: Record<string, unknown>; body: unknown },
  status: number,
) {
  expect(res.status).toBe(status);
  expect(String(res.headers['content-type'])).toMatch(/^application\/problem\+json/);
  return problemSchema.parse(res.body);
}

describe('ingest v2', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
  });
  afterAll(() => db.cleanup());

  async function createToken(
    body: Record<string, unknown>,
  ): Promise<{ id: string; secret: string }> {
    const res = await request(app).post('/api/tokens').send(body).expect(201);
    const created = ingestTokenCreatedSchema.parse(res.body);
    return { id: created.token.id, secret: created.secret };
  }

  const ingest = (target: string, query: string, body: string | Buffer, auth = AUTH) =>
    request(target === 'app' ? app : target)
      .post(`/api/ingest?${query}`)
      .set('Authorization', auth)
      .type('text/plain')
      .send(body);

  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(sql, params);
    return Number(rows[0]?.count);
  }

  describe('gzip', () => {
    it('accepts a gzip body and limits what it inflates to, not what was sent', async () => {
      const body = gzipSync(`${authLine('gz-01', 1)}\n${authLine('gz-01', 2)}\n`);
      const res = await request(app)
        .post('/api/ingest?source=linux_auth&host=gz-01')
        .set('Authorization', AUTH)
        .set('Content-Encoding', 'gzip')
        .type('text/plain')
        .send(body)
        .expect(200);
      expect(ingestSummarySchema.parse(res.body)).toMatchObject({ accepted: 2, rejected: 0 });
    });

    it('answers 400 for a truncated gzip body and stores nothing', async () => {
      const whole = gzipSync(`${authLine('gz-02', 1)}\n`.repeat(50));
      const res = await request(app)
        .post('/api/ingest?source=linux_auth&host=gz-02')
        .set('Authorization', AUTH)
        .set('Content-Encoding', 'gzip')
        .type('text/plain')
        .send(whole.subarray(0, whole.length - 10));
      expectProblem(res, 400);
      expect(await count('SELECT count(*) FROM events WHERE host = $1', ['gz-02'])).toBe(0);
    });

    it.each(['br', 'deflate', 'compress', 'gzip, gzip'])(
      'answers 415 for Content-Encoding: %s',
      async (encoding) => {
        const res = await request(app)
          .post('/api/ingest?source=linux_auth')
          .set('Authorization', AUTH)
          .set('Content-Encoding', encoding)
          .type('text/plain')
          .send('x');
        expectProblem(res, 415);
      },
    );
  });

  describe('on a listening server: the body as it arrives', () => {
    let server: Server;
    let port: number;
    let limitedServer: Server;
    let limitedPort: number;

    beforeAll(async () => {
      server = createServer(createTestApp({ pool: db.pool, signedIn: false }).app);
      limitedServer = createServer(
        createTestApp({ pool: db.pool, signedIn: false, env: { INGEST_MAX_PENDING: '1' } }).app,
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve) => limitedServer.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
      limitedPort = (limitedServer.address() as AddressInfo).port;
    });
    afterAll(async () => {
      server.closeAllConnections();
      limitedServer.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => limitedServer.close(resolve));
    });

    interface Open {
      write(chunk: Buffer | string): void;
      end(): void;
      response: Promise<{ status: number; headers: Record<string, unknown>; body: unknown }>;
    }

    /** A request whose body is sent in pieces and that stays open until `end()`. */
    function open(onPort: number, path: string, headers: Record<string, string>): Open {
      const req = httpRequest({
        host: '127.0.0.1',
        port: onPort,
        method: 'POST',
        path,
        headers: { authorization: AUTH, 'content-type': 'text/plain', ...headers },
      });
      req.on('error', () => undefined);
      const response = new Promise<{
        status: number;
        headers: Record<string, unknown>;
        body: unknown;
      }>((resolve, reject) => {
        req.on('response', (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: JSON.parse(text) as unknown,
            });
          });
          res.on('error', reject);
        });
      });
      req.flushHeaders();
      return { write: (chunk) => req.write(chunk), end: () => req.end(), response };
    }

    it('refuses a gzip body that inflates past 5 MB without inflating all of it', async () => {
      // 10 GB of zeros in 10 MB: one gzip member of 1 MB of zeros, repeated (a gzip stream
      // may hold several members). Inflating all of it would take far longer than this
      // test allows; the server stops at the limit and discards the rest unread.
      const member = gzipSync(Buffer.alloc(1024 * 1024));
      const bomb = Buffer.concat(Array.from({ length: 10_240 }, () => member));
      expect(bomb.length).toBeLessThan(12 * 1024 * 1024);
      const started = performance.now();
      const res = await request(server)
        .post('/api/ingest?source=linux_auth&host=bomb-01')
        .set('Authorization', AUTH)
        .set('Content-Encoding', 'gzip')
        .type('text/plain')
        .send(bomb);
      expectProblem(res, 413);
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    it('answers 503 with Retry-After once INGEST_MAX_PENDING requests are in progress', async () => {
      const first = open(limitedPort, '/api/ingest?source=linux_auth&host=busy-01', {});
      first.write(`${authLine('busy-01', 1)}\n`);
      // The first request holds the only place until its body ends.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = open(limitedPort, '/api/ingest?source=linux_auth&host=busy-02', {});
      second.write(`${authLine('busy-02', 1)}\n`);
      const refused = await second.response;
      expectProblem(refused, 503);
      expect(refused.headers['retry-after']).toBe(String(BUSY_RETRY_AFTER_SECONDS));
      second.end();

      first.end();
      expect((await first.response).status).toBe(200);
      // The place is free again.
      const third = open(limitedPort, '/api/ingest?source=linux_auth&host=busy-03', {});
      third.write(`${authLine('busy-03', 1)}\n`);
      third.end();
      expect((await third.response).status).toBe(200);
      expect(await count('SELECT count(*) FROM events WHERE host = $1', ['busy-02'])).toBe(0);
    });

    it('answers 403 for a host outside the token scope before the body ends', async () => {
      const token = await createToken({ label: 'early scope', hosts: ['web-01'] });
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/ingest?source=linux_auth&host=db-01',
        headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'text/plain' },
      });
      req.on('error', () => undefined);
      const status = new Promise<number>((resolve) =>
        req.on('response', (r) => resolve(r.statusCode ?? 0)),
      );
      req.flushHeaders();
      req.write(`${authLine('db-01')}\n`);
      expect(await status).toBe(403);
      req.end();
    });
  });

  describe('NDJSON objects', () => {
    it('hands a Sysmon object with a message key to the sysmon parser whole (S5-09)', async () => {
      const event = {
        message: 'Process Create:\nRuleName: -\nUtcTime: 2026-10-21 14:41:10.004',
        EventID: 1,
        Computer: 'ws-0142',
        UtcTime: new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 23),
        Image: 'C:\\Windows\\System32\\whoami.exe',
        CommandLine: 'whoami /all',
        ParentImage: 'C:\\Windows\\System32\\cmd.exe',
        User: 'CORP\\j.doe',
      };
      const res = await request(app)
        .post('/api/ingest?source=sysmon&host=ws-0142')
        .set('Authorization', AUTH)
        .type('application/x-ndjson')
        .send(`${JSON.stringify(event)}\n`)
        .expect(200);
      expect(ingestSummarySchema.parse(res.body)).toMatchObject({ accepted: 1, rejected: 0 });
      const { rows } = await db.pool.query<{ fields: Record<string, unknown> }>(
        `SELECT fields FROM events WHERE host = 'ws-0142' AND source = 'sysmon'`,
      );
      expect(rows[0]?.fields).toMatchObject({ Image: event.Image, CommandLine: 'whoami /all' });
    });

    it('takes the message of an object for a line source, and rejects one without', async () => {
      const res = await request(app)
        .post('/api/ingest?source=linux_auth&host=nd-01')
        .set('Authorization', AUTH)
        .type('application/x-ndjson')
        .send(
          `${JSON.stringify({ message: authLine('nd-01') })}\n${JSON.stringify({ msg: 'x' })}\n`,
        )
        .expect(200);
      expect(ingestSummarySchema.parse(res.body)).toMatchObject({
        accepted: 1,
        rejected: 1,
        rejections: [{ line: 2, reason: 'no message in object' }],
      });
    });
  });

  describe('scoped tokens', () => {
    it('refuses a source or a host outside the scope with 403 and stores nothing', async () => {
      const token = await createToken({
        label: 'web shipper',
        sources: ['linux_auth'],
        hosts: ['web-*', 'BASTION-01'],
      });
      const auth = `Bearer ${token.secret}`;
      expectProblem(await ingest('app', 'source=nginx_access&host=web-01', 'x', auth), 403);
      expectProblem(
        await ingest('app', 'source=linux_auth&host=db-01', authLine('db-01'), auth),
        403,
      );
      // Without a host the request is for "unknown", which is outside the scope too.
      expectProblem(await ingest('app', 'source=linux_auth', authLine('web-01'), auth), 403);
      expect(await count('SELECT count(*) FROM events WHERE host = $1', ['db-01'])).toBe(0);

      for (const host of ['web-01', 'WEB-02', 'bastion-01']) {
        const res = await ingest('app', `source=linux_auth&host=${host}`, authLine(host), auth);
        expect(res.status, host).toBe(200);
      }
    });

    it('rejects and counts a line that names a host outside the scope', async () => {
      const token = await createToken({ label: 'one host', hosts: ['web-07'] });
      const res = await ingest(
        'app',
        'source=linux_auth&host=web-07',
        [authLine('web-07', 1), authLine('db-07', 2), authLine('Web-07', 3)].join('\n'),
        `Bearer ${token.secret}`,
      ).expect(200);
      expect(ingestSummarySchema.parse(res.body)).toMatchObject({
        accepted: 2,
        rejected: 1,
        rejections: [{ line: 2, reason: 'host not allowed for this token' }],
      });
      expect(await count('SELECT count(*) FROM events WHERE host = $1', ['db-07'])).toBe(0);
      const { rows } = await db.pool.query<{
        token_id: string;
        rejected: string;
        accepted: string;
      }>(`SELECT token_id, accepted, rejected FROM ingest_streams WHERE host = 'web-07'`);
      expect(rows).toEqual([{ token_id: token.id, accepted: '2', rejected: '1' }]);
    });

    it('an unscoped token and INGEST_TOKEN send any source and host, as before', async () => {
      const token = await createToken({ label: 'unscoped' });
      for (const auth of [`Bearer ${token.secret}`, AUTH]) {
        const res = await ingest(
          'app',
          'source=linux_auth&host=any-01',
          authLine('other-01'),
          auth,
        );
        expect(ingestSummarySchema.parse(res.body)).toMatchObject({ accepted: 1, rejected: 0 });
      }
      const { rows } = await db.pool.query<{ token_id: string | null }>(
        `SELECT token_id FROM ingest_streams WHERE host = 'any-01' ORDER BY token_id NULLS LAST`,
      );
      // Each stream is tied to the token that delivers it; INGEST_TOKEN has no row.
      expect(rows).toEqual([{ token_id: token.id }, { token_id: null }]);
    });

    it.each([
      ['a regex', ['web-(01|02)']],
      ['a star in the middle', ['web-*-01']],
      ['a space', ['web 01']],
      ['an unknown source', { sources: ['windows_event'] }],
      ['a pattern that is too long', ['a'.repeat(300)]],
      ['too many hosts', Array.from({ length: 101 }, (_, i) => `h${i}`)],
    ])('refuses a scope with %s', async (_name, scope) => {
      const body = Array.isArray(scope)
        ? { label: 'bad', hosts: scope }
        : { label: 'bad', ...scope };
      const res = await request(app).post('/api/tokens').send(body);
      expectProblem(res, 400);
    });

    it('treats hostile host names as text, never as a pattern', async () => {
      const token = await createToken({ label: 'prefix', hosts: ['a.b*'] });
      const auth = `Bearer ${token.secret}`;
      // "." is a literal dot: "aXb" does not start with "a.b".
      expectProblem(
        await ingest('app', 'source=linux_auth&host=aXb-01', authLine('aXb-01'), auth),
        403,
      );
      expect(
        (await ingest('app', 'source=linux_auth&host=a.b-01', authLine('a.b-01'), auth)).status,
      ).toBe(200);
      const hostile = `a.b${'(a+)+'.repeat(2000)}`;
      const started = performance.now();
      const res = await ingest(
        'app',
        'source=linux_auth&host=a.b-02',
        `Oct 25 14:03:12 ${hostile} sshd[1]: Failed password for root from 203.0.113.45 port 40000 ssh2`,
        auth,
      ).expect(200);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(ingestSummarySchema.parse(res.body).accepted).toBe(1);
    });
  });

  describe('streams per token', () => {
    it('lets two tokens each reach 1,000 streams on their own', async () => {
      const a = await createToken({ label: 'streams a' });
      const b = await createToken({ label: 'streams b' });
      const fill = (tokenId: string, howMany: number) =>
        db.pool.query(
          `INSERT INTO ingest_streams (id, kind, token_id, source, host)
           SELECT gen_random_uuid(), 'token', $1::uuid, 'linux_auth', 'fill-' || $1::text || '-' || n
             FROM generate_series(1, $2::integer) AS n`,
          [tokenId, howMany],
        );
      const send = (secret: string, host: string) =>
        ingest('app', `source=linux_auth&host=${host}`, authLine(host), `Bearer ${secret}`);
      try {
        await fill(a.id, 999);
        expect((await send(a.secret, 'stream-a-1000')).status).toBe(200);
        expectProblem(await send(a.secret, 'stream-a-1001'), 403);
        // A host the token already delivers for is not a new stream.
        expect((await send(a.secret, 'stream-a-1000')).status).toBe(200);

        // B's count is its own: A's thousand streams do not use any of it.
        await fill(b.id, 999);
        expect((await send(b.secret, 'stream-b-1000')).status).toBe(200);
        expectProblem(await send(b.secret, 'stream-b-1001'), 403);
        // INGEST_TOKEN has its own bound, and its streams have no token id.
        expect((await send(DEV_INGEST_TOKEN, 'stream-env-1')).status).toBe(200);
        const { rows } = await db.pool.query<{ token_id: string | null }>(
          `SELECT token_id FROM ingest_streams WHERE host = 'stream-env-1'`,
        );
        expect(rows).toEqual([{ token_id: null }]);
      } finally {
        await db.pool.query(`DELETE FROM ingest_streams WHERE host LIKE 'fill-%'`);
      }
    });
  });

  describe('limits', () => {
    it('gives each token its own budget, and answers 429 with Retry-After past it', async () => {
      const { app: limited } = createTestApp({
        pool: db.pool,
        env: { RATE_LIMIT_INGEST_PER_MINUTE: '2' },
      });
      const a = `Bearer ${(await createToken({ label: 'budget a' })).secret}`;
      const b = `Bearer ${(await createToken({ label: 'budget b' })).secret}`;
      const send = (auth: string) =>
        ingest(limited as unknown as string, 'source=linux_auth', '', auth);
      await send(a).expect(200);
      await send(a).expect(200);
      const refused = await send(a);
      expectProblem(refused, 429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
      // Another token from the same address has its own budget, and so has INGEST_TOKEN.
      await send(b).expect(200);
      await send(AUTH).expect(200);
    });

    it('limits requests without a valid token per address, at RATE_LIMIT_AUTH_PER_MINUTE', async () => {
      const { app: limited } = createTestApp({
        pool: db.pool,
        env: { RATE_LIMIT_AUTH_PER_MINUTE: '2' },
      });
      const send = (auth: string) =>
        ingest(limited as unknown as string, 'source=linux_auth', '', auth);
      await send('Bearer wrong-1').expect(401);
      await send(`Bearer cnt_${'A'.repeat(43)}`).expect(401);
      const refused = await send('Bearer wrong-3');
      expectProblem(refused, 429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // Past the limit the address is not even asked for its token: a guesser cannot go on.
      expectProblem(await send(AUTH), 429);
    });

    it('counts the client address a trusted proxy names, one budget per address', async () => {
      const { app: proxied } = createTestApp({
        pool: db.pool,
        env: { RATE_LIMIT_AUTH_PER_MINUTE: '1', TRUST_PROXY: 'loopback' },
      });
      const send = (from: string) =>
        request(proxied)
          .post('/api/ingest?source=linux_auth')
          .set('Authorization', 'Bearer wrong')
          .set('X-Forwarded-For', from)
          .type('text/plain')
          .send('');
      await send('198.51.100.10').expect(401);
      expectProblem(await send('198.51.100.10'), 429);
      await send('198.51.100.11').expect(401);
    });
  });
});
