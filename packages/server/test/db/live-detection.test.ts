/**
 * The database side of live detection (S12): streams, the stream of every event, the
 * checkpoint row, the events read back after a restart, and a restart of the real pipeline
 * against PostgreSQL.
 */
import { gzipSync } from 'node:zlib';
import type { NormalizedEvent } from '@centinela/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCheckpointStore } from '../../src/db/checkpoint.js';
import { createEventReader } from '../../src/db/events-recovery.js';
import { createEventStore } from '../../src/db/events-write.js';
import { createStreamRegistry, MAX_STREAMS_PER_TOKEN } from '../../src/db/streams.js';
import { createDetector } from '../../src/detection/index.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { SNAPSHOT_VERSION } from '../../src/pipeline/orchestrator.js';
import { StreamLimitError, type IngestContext, type StreamKey } from '../../src/pipeline/types.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RULES_DIR } from '../pipeline/live.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(() => db.cleanup());
beforeEach(async () => {
  await db.pool.query(
    'TRUNCATE alert_events, alerts, events, detector_checkpoints, ingest_streams, ingest_tokens',
  );
});

const key = (overrides: Partial<StreamKey> = {}): StreamKey => ({
  kind: 'token',
  tokenId: null,
  source: 'linux_auth',
  host: 'web-01',
  ...overrides,
});

async function createToken(label: string): Promise<string> {
  const id = uuidv7();
  await db.pool.query(
    `INSERT INTO ingest_tokens (id, label, token_hash, prefix, created_by)
     VALUES ($1, $2, $3, 'cnt_test', 'admin')`,
    [id, label, Buffer.from(id)],
  );
  return id;
}

function event(seconds: number, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: uuidv7(),
    ts: new Date(Date.parse('2026-10-25T10:00:00Z') + seconds * 1000).toISOString(),
    ingestedAt: '2026-10-25T12:00:00.000Z',
    source: 'linux_auth',
    host: 'bastion-01',
    // What the auth parser gives an sshd line; the reader rebuilds it from `process.name`.
    logsources: [
      { product: 'linux', service: 'sshd' },
      { product: 'linux', service: 'auth' },
    ],
    category: 'authentication',
    action: 'ssh_login',
    outcome: 'failure',
    user: 'root',
    srcIp: '203.0.113.45',
    message: `Failed password for root from 203.0.113.45 port ${40000 + seconds} ssh2`,
    fields: { 'event.action': 'ssh_login', 'process.name': 'sshd' },
    ...overrides,
  };
}

describe('stream registry', () => {
  it('creates one row per delivery path and returns the same id afterwards', async () => {
    const registry = createStreamRegistry(db.pool);
    const first = await registry.resolve(key());
    expect(await registry.resolve(key())).toBe(first);
    // Another process (no cache) finds the same row.
    expect(await createStreamRegistry(db.pool).resolve(key())).toBe(first);

    const token = await createToken('branch office');
    const others = await Promise.all([
      registry.resolve(key({ host: 'web-02' })),
      registry.resolve(key({ source: 'nginx_access' })),
      registry.resolve(key({ kind: 'upload' })),
      registry.resolve(key({ kind: 'cli' })),
      registry.resolve(key({ tokenId: token })),
    ]);
    expect(new Set([first, ...others]).size).toBe(6);

    const { rows } = await db.pool.query<{ kind: string; token_id: string | null; n: string }>(
      `SELECT kind, token_id, count(*) AS n FROM ingest_streams
        GROUP BY kind, token_id ORDER BY kind, token_id NULLS FIRST`,
    );
    expect(rows).toEqual([
      { kind: 'cli', token_id: null, n: '1' },
      { kind: 'token', token_id: null, n: '3' },
      { kind: 'token', token_id: token, n: '1' },
      { kind: 'upload', token_id: null, n: '1' },
    ]);
  });

  it('adds the counts of every call and keeps the newest signal', async () => {
    const registry = createStreamRegistry(db.pool);
    const id = await registry.resolve(key());
    // Receive times after the row was created, as in a running server.
    const received = (seconds: number) => new Date(Date.now() + seconds * 1000);
    const newest = received(20);
    await registry.record(id, {
      accepted: 10,
      rejected: 1,
      late: 2,
      lastEventTs: new Date('2026-10-25T10:00:09Z'),
      at: received(10),
    });
    // An older backlog arrives later, and then a call that accepted nothing.
    await registry.record(id, {
      accepted: 5,
      rejected: 0,
      late: 5,
      lastEventTs: new Date('2026-10-25T09:00:00Z'),
      at: newest,
    });
    await registry.record(id, {
      accepted: 0,
      rejected: 3,
      late: 0,
      lastEventTs: null,
      at: received(15),
    });
    const { rows } = await db.pool.query(
      `SELECT accepted, rejected, late, last_seen_at, last_event_ts FROM ingest_streams WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      accepted: '15',
      rejected: '4',
      late: '7',
      last_seen_at: newest,
      last_event_ts: new Date('2026-10-25T10:00:09Z'),
    });
  });

  it('refuses a new stream once a token owns the maximum, per token', async () => {
    const token = await createToken('noisy');
    await db.pool.query(
      `INSERT INTO ingest_streams (id, kind, token_id, source, host)
       SELECT gen_random_uuid(), 'token', $1::uuid, 'linux_auth', 'host-' || n
         FROM generate_series(1, $2) AS n`,
      [token, MAX_STREAMS_PER_TOKEN],
    );
    const registry = createStreamRegistry(db.pool);
    await expect(registry.resolve(key({ tokenId: token, host: 'one-more' }))).rejects.toThrow(
      StreamLimitError,
    );
    // Streams it already has keep working, and so do other tokens and other kinds.
    await expect(registry.resolve(key({ tokenId: token, host: 'host-7' }))).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await expect(registry.resolve(key({ host: 'one-more' }))).resolves.toBeTruthy();
    await expect(registry.resolve(key({ kind: 'upload', host: 'one-more' }))).resolves.toBeTruthy();
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM ingest_streams WHERE token_id = $1',
      [token],
    );
    expect(rows[0]?.n).toBe(String(MAX_STREAMS_PER_TOKEN));
  });

  it('takes a hostile host name as a value', async () => {
    const registry = createStreamRegistry(db.pool);
    const host = `x'); DROP TABLE ingest_streams; --`;
    const id = await registry.resolve(key({ host }));
    const { rows } = await db.pool.query<{ host: string }>(
      'SELECT host FROM ingest_streams WHERE id = $1',
      [id],
    );
    expect(rows[0]?.host).toBe(host);
  });
});

describe('the stream of every event', () => {
  it('is stored with the events of a call and stays null without one', async () => {
    const registry = createStreamRegistry(db.pool);
    const stream = await registry.resolve(key());
    const store = createEventStore(db.pool);
    const withStream = [event(1), event(2)];
    const without = [event(3)];
    await store.insertMany(withStream, { streamId: stream });
    await store.insertMany(without);
    const { rows } = await db.pool.query<{ id: string; stream_id: string | null }>(
      'SELECT id, stream_id FROM events ORDER BY ts',
    );
    expect(rows).toEqual([
      { id: withStream[0]?.id, stream_id: stream },
      { id: withStream[1]?.id, stream_id: stream },
      { id: without[0]?.id, stream_id: null },
    ]);
  });
});

describe('checkpoint store', () => {
  it('is empty at first, then holds the last saved state', async () => {
    const store = createCheckpointStore(db.pool);
    expect(await store.load()).toBeNull();
    const position = uuidv7();
    const state = { engine: { watermark: 1, text: 'ñ ☃ "quoted" \\ \u0000' }, buffer: [1, 2, 3] };
    await store.save({ position, version: 1, state });
    expect(await store.load()).toEqual({ position, version: 1, state });

    await store.save({ position: null, version: 2, state: { replaced: true } });
    expect(await store.load()).toEqual({ position: null, version: 2, state: { replaced: true } });
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM detector_checkpoints',
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('keeps separate checkpoints by name', async () => {
    await createCheckpointStore(db.pool).save({ position: null, version: 1, state: 'live' });
    await createCheckpointStore(db.pool, 'other').save({ position: null, version: 1, state: 'x' });
    expect((await createCheckpointStore(db.pool).load())?.state).toBe('live');
    expect((await createCheckpointStore(db.pool, 'other').load())?.state).toBe('x');
  });

  it('compresses the state: ten thousand similar matches take a fraction of their JSON', async () => {
    const store = createCheckpointStore(db.pool);
    const state = {
      groups: Array.from({ length: 10_000 }, (_, i) => ({
        ruleId: '5e1c0f7a-3b2d-4c6e-9f80-112233445566',
        time: 1_792_000_000_000 + i,
        host: 'bastion-01',
        ip: '203.0.113.45',
      })),
    };
    await store.save({ position: null, version: 1, state });
    const { rows } = await db.pool.query<{ bytes: number }>(
      'SELECT octet_length(state) AS bytes FROM detector_checkpoints',
    );
    expect(rows[0]?.bytes).toBeLessThan(JSON.stringify(state).length / 5);
    expect((await store.load())?.state).toEqual(state);
  });

  it.each([
    ['bytes that are not gzip', Buffer.from('not gzip at all')],
    ['gzip of something that is not JSON', gzipSync(Buffer.from('{"engine": '))],
  ])('returns no state for %s, and keeps the position', async (_, bytes) => {
    const position = uuidv7();
    await db.pool.query(
      `INSERT INTO detector_checkpoints (name, position, state, state_version)
       VALUES ('live', $1, $2, 1)`,
      [position, bytes],
    );
    expect(await createCheckpointStore(db.pool).load()).toEqual({
      position,
      version: 1,
      state: undefined,
    });
  });
});

describe('event reader', () => {
  it('reads events back by id with the logsources their parser gave them', async () => {
    const stored = [event(1), event(2, { user: 'alice', srcIp: '2001:db8::1' }), event(3)];
    await createEventStore(db.pool).insertMany(stored);
    const reader = createEventReader(db.pool);
    const wanted = [stored[2], stored[0]].flatMap((e) => (e ? [e.id] : []));
    const found = await reader.byIds([...wanted, uuidv7()]);
    expect(found.map((e) => e.id).sort()).toEqual([...wanted].sort());
    expect(found.find((e) => e.id === stored[0]?.id)).toEqual(stored[0]);
    expect(await reader.byIds([])).toEqual([]);
  });

  it('ignores ids that are not UUIDs: they name no event and must not fail the query', async () => {
    const stored = [event(1), event(2)];
    await createEventStore(db.pool).insertMany(stored);
    const reader = createEventReader(db.pool);
    const hostile = ['event-00000001', "x'); DROP TABLE events; --", '', stored[1]?.id ?? ''];
    expect((await reader.byIds(hostile)).map((e) => e.id)).toEqual([stored[1]?.id]);
    expect(await reader.byIds(['not-a-uuid'])).toEqual([]);
  });

  it('reads what the server stored after a position, in id order, without the command line', async () => {
    const registry = createStreamRegistry(db.pool);
    const store = createEventStore(db.pool);
    const token = await registry.resolve(key());
    const upload = await registry.resolve(key({ kind: 'upload' }));
    const cli = await registry.resolve(key({ kind: 'cli' }));
    const reader = createEventReader(db.pool);
    expect(await reader.newestId()).toBeNull();

    const before = [event(1)];
    await store.insertMany(before); // stored before streams existed
    const fromToken = [event(2), event(3)];
    await store.insertMany(fromToken, { streamId: token });
    const fromCli = [event(4)];
    await store.insertMany(fromCli, { streamId: cli });
    const fromUpload = [event(5)];
    await store.insertMany(fromUpload, { streamId: upload });

    const expected = [...fromToken, ...fromUpload].map((e) => e.id);
    expect((await reader.after(null, 10)).map((e) => e.id)).toEqual(expected);
    expect((await reader.after(null, 2)).map((e) => e.id)).toEqual(expected.slice(0, 2));
    expect((await reader.after(fromToken[0]?.id ?? null, 10)).map((e) => e.id)).toEqual(
      expected.slice(1),
    );
    expect(await reader.after(fromUpload[0]?.id ?? null, 10)).toEqual([]);
    expect(await reader.newestId()).toBe(fromUpload[0]?.id);
  });
});

describe('a restart of the pipeline against PostgreSQL', () => {
  const ATTACKER = '203.0.113.45';
  const BRUTE_FORCE = 'SSH brute force from a single source';
  const failures = (from: number, to: number) =>
    Array.from(
      { length: to - from },
      (_, i) =>
        `2026-10-25T11:00:${String(from + i).padStart(2, '0')}Z bastion-01 sshd[4242]: Failed password for root from ${ATTACKER} port 50022 ssh2`,
    );
  const shipper = (ack: 'evaluated' | 'stored' = 'evaluated'): IngestContext => ({
    source: 'linux_auth',
    host: 'bastion-01',
    timezone: 'UTC',
    receivedAt: new Date('2026-10-25T11:01:00Z'),
    stream: { kind: 'token', tokenId: null },
    ack,
  });
  const server = () =>
    createPipeline({
      pool: db.pool,
      detector: createDetector({ rulesDir: RULES_DIR }),
      checkpoint: true,
      reorder: { idleMs: Number.POSITIVE_INFINITY },
    });
  const alerts = async () => {
    const { rows } = await db.pool.query<{ rule_title: string; count: number; links: string }>(
      `SELECT a.rule_title, a.count,
              (SELECT count(*) FROM alert_events ae WHERE ae.alert_id = a.id) AS links
         FROM alerts a WHERE a.rule_type = 'correlation' ORDER BY a.rule_title`,
    );
    return rows.map((row) => `${row.rule_title} x${row.count} (${row.links} events)`);
  };

  it('clean stop in the middle of a window: the alert still fires, with all ten events', async () => {
    const first = server();
    expect(await first.restore()).toMatchObject({ restored: false, replayed: 0 });
    // Four evaluated, two still waiting in the buffer.
    await first.ingest(failures(0, 4), shipper());
    await first.ingest(failures(4, 6), shipper('stored'));
    expect(first.stats()).toMatchObject({ evaluated: 4, buffered: 2 });
    first.stop();
    expect(await first.checkpoint()).toBe(true);
    expect(await alerts()).toEqual([]);

    const second = server();
    expect(await second.restore()).toMatchObject({
      restored: true,
      rules: { restored: 2, dropped: 0 },
      buffered: 2,
      replayed: 0,
    });
    await second.ingest(failures(6, 10), shipper());
    expect(await alerts()).toEqual([`${BRUTE_FORCE} x1 (10 events)`]);
    second.stop();
  });

  it('a saved state that names waiting events that are not event ids is restored without them', async () => {
    const first = server();
    await first.ingest(failures(0, 4), shipper());
    await first.ingest(failures(4, 6), shipper('stored'));
    first.stop();
    await first.checkpoint();

    const store = createCheckpointStore(db.pool);
    const saved = await store.load();
    const state = saved?.state as { buffer: { events: Array<{ id: string; time: number }> } };
    state.buffer.events.push({ id: 'not-an-event-id', time: Date.parse('2026-10-25T11:00:05Z') });
    await store.save({ position: saved?.position ?? null, version: SNAPSHOT_VERSION, state });

    // The query that reads the waiting events back does not fail on the id, so the
    // windows and the two real events come back and the alert has all ten.
    const second = server();
    expect(await second.restore()).toMatchObject({
      restored: true,
      rules: { restored: 2, dropped: 0 },
      buffered: 2,
    });
    await second.ingest(failures(6, 10), shipper());
    expect(await alerts()).toEqual([`${BRUTE_FORCE} x1 (10 events)`]);
    second.stop();
  });

  it('without a checkpoint the same restart misses the alert', async () => {
    const first = createPipeline({
      pool: db.pool,
      detector: createDetector({ rulesDir: RULES_DIR }),
    });
    await first.ingest(failures(0, 6), shipper());
    const second = createPipeline({
      pool: db.pool,
      detector: createDetector({ rulesDir: RULES_DIR }),
    });
    await second.ingest(failures(6, 10), shipper());
    expect(await alerts()).toEqual([]);
  });

  it('crash after the checkpoint: what was stored since is evaluated again, the command line is not', async () => {
    const first = server();
    await first.ingest(failures(0, 3), shipper());
    await first.checkpoint();
    // After the checkpoint: three more evaluated, two waiting, and a file ingested with
    // `npm run ingest` by another process. Then the server dies.
    await first.ingest(failures(3, 6), shipper());
    await first.ingest(failures(6, 8), shipper('stored'));
    const cli = createPipeline({
      pool: db.pool,
      detector: createDetector({ rulesDir: RULES_DIR }),
    });
    await cli.ingest(
      Array.from(
        { length: 12 },
        (_, i) =>
          `2026-10-25T09:00:${String(i).padStart(2, '0')}Z db-01 sshd[77]: Failed password for root from 198.51.100.7 port 4000 ssh2`,
      ),
      { ...shipper(), host: 'db-01', stream: { kind: 'cli', tokenId: null } },
    );
    expect(await alerts()).toEqual([`${BRUTE_FORCE} x1 (10 events)`]);
    first.stop();

    const second = server();
    const restored = await second.restore();
    expect(restored).toMatchObject({ restored: true, buffered: 0, replayed: 5 });
    await second.ingest(failures(8, 10), shipper());
    // One alert for db-01 from the command line, untouched, and one for bastion-01.
    expect(await alerts()).toEqual([
      `${BRUTE_FORCE} x1 (10 events)`,
      `${BRUTE_FORCE} x1 (10 events)`,
    ]);
    second.stop();
  });

  it('the saved row carries the version and a position that is a stored event', async () => {
    const pipeline = server();
    await pipeline.ingest(failures(0, 3), shipper('stored'));
    await pipeline.checkpoint();
    pipeline.stop();
    const { rows } = await db.pool.query<{ state_version: number; known: boolean }>(
      `SELECT c.state_version, EXISTS (SELECT 1 FROM events e WHERE e.id = c.position) AS known
         FROM detector_checkpoints c`,
    );
    expect(rows).toEqual([{ state_version: SNAPSHOT_VERSION, known: true }]);
  });
});
