/**
 * The bound on `/api/ingest` requests in progress (ARCHITECTURE §9, check 6; S11 review,
 * S11-R01). A request keeps its place until the server is done with it, whatever its
 * client does: a client that leaves while its request waits for the pipeline does not let
 * another one in, and no place is kept for good by a client that left early.
 *
 * Requests are written on raw sockets so the client can leave at a chosen moment, and the
 * pipeline is gated so requests wait in it as they would behind a slow batch.
 */
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createToken } from '../../src/auth/ingest-tokens.js';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const LINE =
  'Oct 25 14:03:12 web-01 sshd[1]: Failed password for root from 203.0.113.45 port 40000 ssh2\n';
const PATH = '/api/ingest?source=linux_auth&host=web-01&ack=stored';

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The pipeline holds every call until `open()`, and counts calls and settled calls. */
function gatePipeline(deps: AppDeps) {
  const real = deps.pipeline;
  let calls = 0;
  let settled = 0;
  let shut = true;
  const waiting: Array<() => void> = [];
  deps.pipeline = {
    ...real,
    async ingest(lines, ctx) {
      calls += 1;
      try {
        if (shut) await new Promise<void>((resolve) => waiting.push(resolve));
        return await real.ingest(lines, ctx);
      } finally {
        settled += 1;
      }
    },
  };
  return {
    calls: () => calls,
    settled: () => settled,
    open() {
      shut = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
    shut() {
      shut = true;
    },
  };
}

interface RawRequest {
  /** The answer's status code once it arrives; 0 when the connection closed first. */
  status: Promise<number>;
  /** The status code if it arrived already. */
  answered(): number | undefined;
  /** The client goes away. */
  leave(): void;
}

function head(token: string, length: number, extra = ''): string {
  return (
    `POST ${PATH} HTTP/1.1\r\nHost: centinela.test\r\nAuthorization: Bearer ${token}\r\n` +
    `Content-Type: text/plain\r\n${extra}Content-Length: ${length}\r\n\r\n`
  );
}

/** `times` copies of one request written at once on a new connection (HTTP pipelining). */
function rawPost(port: number, token: string, times = 1): RawRequest {
  return rawWrite(port, `${head(token, Buffer.byteLength(LINE))}${LINE}`.repeat(times));
}

/** Bytes written on a new connection, which then stays open until `leave()`. */
function rawWrite(port: number, data: string | Buffer): RawRequest {
  const socket = connect(port, '127.0.0.1');
  let received = '';
  let code: number | undefined;
  socket.setEncoding('latin1');
  socket.on('error', () => undefined);
  const status = new Promise<number>((resolve) => {
    socket.on('data', (chunk: string) => {
      received += chunk;
      const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (match && code === undefined) {
        code = Number(match[1]);
        resolve(code);
      }
    });
    socket.on('close', () => resolve(code ?? 0));
  });
  socket.write(data);
  return { status, answered: () => code, leave: () => socket.destroy() };
}

describe('requests in progress on /api/ingest', () => {
  let db: TestDatabase;
  let server: Server | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  });
  afterAll(() => db.cleanup());

  /** `perToken` defaults to `maxPending`: one token may hold every place. */
  async function start(maxPending: number, perToken = maxPending) {
    const { app, deps } = createTestApp({
      pool: db.pool,
      signedIn: false,
      env: {
        INGEST_MAX_PENDING: String(maxPending),
        INGEST_MAX_PENDING_PER_TOKEN: String(perToken),
        RATE_LIMIT_INGEST_PER_MINUTE: '1000',
      },
    });
    const gate = gatePipeline(deps);
    const listening = createServer(app);
    server = listening;
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    const { port } = listening.address() as AddressInfo;
    let connections = -1;
    const countConnections = () =>
      listening.getConnections((_err, count) => {
        connections = count;
      });
    /** Wait until the server has seen every client connection close. */
    const noConnections = async () => {
      await until(() => {
        countConnections();
        return connections === 0;
      }, 'the server to see the clients leave');
    };
    return { port, gate, noConnections };
  }

  it('keeps no place for a client that left while its token was checked', async () => {
    const { port, gate, noConnections } = await start(1);
    gate.open();
    const created = await createToken(db.pool, { label: 'leaves early', createdBy: 'test' });
    if (!created.ok) throw new Error('token not created');
    // Hold the token's row, so checking the token (it records its first use) waits.
    const locker = await db.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM ingest_tokens WHERE id = $1 FOR UPDATE', [
        created.token.id,
      ]);
      const { rows } = await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const lockerPid = rows[0]?.pid;
      const early = rawPost(port, created.secret);
      let blocked = 0;
      await until(() => {
        void db.pool
          .query<{ count: string }>(
            'SELECT count(*) AS count FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
            [lockerPid],
          )
          .then((r) => (blocked = Number(r.rows[0]?.count)));
        return blocked > 0;
      }, 'the token check to wait for the row');
      early.leave();
      await noConnections();
      await locker.query('COMMIT');
    } finally {
      locker.release();
    }
    // The token check ends after its client left; give the rest of the checks time to run.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const next = rawPost(port, DEV_INGEST_TOKEN);
    expect(await next.status).toBe(200);
  });

  it('gives back the place of a pipelined request whose client left', async () => {
    const { port, gate, noConnections } = await start(2);
    // Two requests in one write: the second is answered only after the first.
    const pair = rawPost(port, DEV_INGEST_TOKEN, 2);
    await until(() => gate.calls() === 2, 'both requests to reach the pipeline');
    pair.leave();
    await noConnections();
    gate.open();
    await until(() => gate.settled() === 2, 'the pipeline to finish both');

    // Both places are free again: two requests get in, the third is told to wait.
    gate.shut();
    const first = rawPost(port, DEV_INGEST_TOKEN);
    await until(() => gate.calls() === 3 || first.answered() !== undefined, 'the first');
    const second = rawPost(port, DEV_INGEST_TOKEN);
    await until(() => gate.calls() === 4 || second.answered() !== undefined, 'the second');
    expect(second.answered()).toBeUndefined();
    expect(gate.calls()).toBe(4);
    const third = rawPost(port, DEV_INGEST_TOKEN);
    expect(await third.status).toBe(503);
    gate.open();
    expect(await first.status).toBe(200);
    expect(await second.status).toBe(200);
  });

  it('keeps the place of a request whose client left while it waits for the pipeline', async () => {
    const { port, gate, noConnections } = await start(2);
    const a = rawPost(port, DEV_INGEST_TOKEN);
    await until(() => gate.calls() === 1, 'the first request to reach the pipeline');
    a.leave();
    const b = rawPost(port, DEV_INGEST_TOKEN);
    await until(() => gate.calls() === 2, 'the second request to reach the pipeline');
    b.leave();
    await noConnections();

    // Both requests are still in the pipeline, holding their bodies: the bound holds.
    const c = rawPost(port, DEV_INGEST_TOKEN);
    await until(() => gate.calls() === 3 || c.answered() !== undefined, 'the third');
    expect(gate.calls()).toBe(2);
    expect(await c.status).toBe(503);

    // Once the pipeline is done with them, their places are free.
    gate.open();
    await until(() => gate.settled() === 2, 'the pipeline to finish both');
    const d = rawPost(port, DEV_INGEST_TOKEN);
    expect(await d.status).toBe(200);
  });

  it('gives back the place of a gzip body whose client left before sending all of it', async () => {
    const { port, gate, noConnections } = await start(1);
    gate.open();
    // Its first half only: inflating stops waiting for the rest, and never ends.
    const body = gzipSync(LINE.repeat(2000));
    const half = rawWrite(
      port,
      Buffer.concat([
        Buffer.from(head(DEV_INGEST_TOKEN, body.length, 'Content-Encoding: gzip\r\n')),
        body.subarray(0, body.length >> 1),
      ]),
    );
    // While its body is read the request holds the only place. The next request is sent a
    // moment later, so the half body is surely the first to take it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refused = rawPost(port, DEV_INGEST_TOKEN);
    expect(await refused.status).toBe(503);
    refused.leave();
    half.leave();
    await noConnections();
    expect(await rawPost(port, DEV_INGEST_TOKEN).status).toBe(200);
    expect(half.answered()).toBeUndefined();
  });

  it('lets one token hold only its share of the places, so slow bodies cannot stop the others (S11-R05)', async () => {
    const { port, gate } = await start(4, 2);
    gate.open();
    const slow = await createToken(db.pool, { label: 'slow sender', createdBy: 'test' });
    const other = await createToken(db.pool, { label: 'other shipper', createdBy: 'test' });
    if (!slow.ok || !other.ok) throw new Error('token not created');
    // The slow sender opens four requests and never finishes their bodies.
    const length = Buffer.byteLength(LINE) * 100;
    const opened = Array.from({ length: 4 }, () =>
      rawWrite(port, `${head(slow.secret, length)}${LINE}`),
    );
    // Two of them hold places and two are refused with 429. Which two depends on which
    // token checks end first, so the test waits for any two answers.
    await until(
      () => opened.filter((request) => request.answered() !== undefined).length >= 2,
      'two of the slow requests to be refused',
    );
    const answers = opened.map((request) => request.answered());
    expect(answers.filter((status) => status === 429)).toHaveLength(2);
    expect(answers.filter((status) => status === undefined)).toHaveLength(2);
    // Another shipper still gets in, and so does INGEST_TOKEN.
    expect(await rawPost(port, other.secret).status).toBe(200);
    expect(await rawPost(port, DEV_INGEST_TOKEN).status).toBe(200);
    for (const request of opened) request.leave();
  });
});
