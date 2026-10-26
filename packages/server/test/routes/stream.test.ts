import { get, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { alertSchema, problemSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const SUDO_LINE =
  '2026-10-25T14:03:12.000000+00:00 db-01 sudo[4242]:   intern : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/bin/ls';

interface Stream {
  res: IncomingMessage;
  /** Resolves with the next SSE block (text up to a blank line). */
  next(): Promise<string>;
}

function openStream(port: number): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = get({ port, path: '/api/stream', headers: { Accept: 'text/event-stream' } });
    req.on('error', reject);
    req.on('response', (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      const waiting: Array<(block: string) => void> = [];
      const flush = () => {
        let end = buffer.indexOf('\n\n');
        while (end !== -1 && waiting.length > 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          waiting.shift()?.(block);
          end = buffer.indexOf('\n\n');
        }
      };
      res.on('data', (chunk: string) => {
        buffer += chunk;
        flush();
      });
      resolve({
        res,
        next: () =>
          new Promise<string>((done) => {
            waiting.push(done);
            flush();
          }),
      });
    });
  });
}

describe('GET /api/stream', () => {
  let db: TestDatabase;
  let server: Server;
  let port: number;
  let testApp: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    db = await createTestDatabase();
    testApp = createTestApp({ pool: db.pool, hub: { maxClients: 2 } });
    server = testApp.app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    testApp.deps.hub.close();
    await new Promise((resolve) => server.close(resolve));
    await db.cleanup();
  });

  it('streams alert.created from ingest and alert.updated from triage', async () => {
    const stream = await openStream(port);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(await stream.next()).toBe(': connected');

    const summary = await request(server)
      .post('/api/ingest?source=linux_auth&host=db-01')
      .set('Authorization', `Bearer ${DEV_INGEST_TOKEN}`)
      .type('text/plain')
      .send(SUDO_LINE)
      .expect(200);
    expect(summary.body).toMatchObject({ accepted: 1, alertsCreated: 1 });

    const created = (await stream.next()).split('\n');
    expect(created[0]).toBe('event: alert.created');
    const alert = alertSchema.parse(JSON.parse(created[1]?.replace(/^data: /, '') ?? ''));
    expect(alert.host).toBe('db-01');
    expect(alert.ruleTitle).toMatch(/sudoers/i);

    await request(server)
      .patch(`/api/alerts/${alert.id}`)
      .send({ status: 'acknowledged' })
      .expect(200);
    const updated = (await stream.next()).split('\n');
    expect(updated[0]).toBe('event: alert.updated');
    expect(JSON.parse(updated[1]?.replace(/^data: /, '') ?? '')).toMatchObject({
      id: alert.id,
      status: 'acknowledged',
    });
    stream.res.destroy();
  });

  it('answers 503 problem+json when the hub is full', async () => {
    await expect.poll(() => testApp.deps.hub.size).toBe(0);
    const a = await openStream(port);
    const b = await openStream(port);
    await Promise.all([a.next(), b.next()]);
    const res = await request(server).get('/api/stream').expect(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemSchema.parse(res.body).detail).toMatch(/live connections/);
    a.res.destroy();
    b.res.destroy();
    // The hub notices the disconnects and accepts clients again.
    await expect.poll(() => testApp.deps.hub.size).toBe(0);
    const c = await openStream(port);
    expect(await c.next()).toBe(': connected');
    c.res.destroy();
  });
});
