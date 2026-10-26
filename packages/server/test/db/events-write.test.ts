import type { NormalizedEvent } from '@centinela/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEventStore, INSERT_CHUNK_SIZE } from '../../src/db/events-write.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

function event(i: number, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: uuidv7(),
    ts: new Date(Date.UTC(2026, 9, 21, 3, 12, 0, i)).toISOString(),
    ingestedAt: '2026-10-26T12:00:00.000Z',
    source: 'linux_auth',
    host: 'bastion-01',
    logsources: [{ product: 'linux', service: 'sshd' }],
    category: 'authentication',
    action: 'ssh_login',
    outcome: 'failure',
    user: 'root',
    srcIp: '203.0.113.45',
    srcPort: 40000 + (i % 1000),
    message: `Failed password for root from 203.0.113.45 port ${40000 + (i % 1000)} ssh2`,
    fields: { 'event.action': 'ssh_login', 'source.port': 40000 + (i % 1000), n: i },
    ...overrides,
  };
}

describe('PostgreSQL event store', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  it('inserts events with every column and the fields as jsonb', async () => {
    const e = event(1, {
      srcIp: '2001:db8::1',
      message: 'it\'s "quoted" \\ and \' OR 1=1-- <script>',
      fields: { 'event.action': 'ssh_login', nested: 'a"b\\c', flag: true, none: null, n: 1.5 },
    });
    await createEventStore(db.pool).insertMany([e]);
    const { rows } = await db.pool.query<Record<string, unknown>>(
      `SELECT id, ts, ingested_at, source, host, category, action, outcome, user_name,
              host(src_ip) AS src_ip, src_port, message, fields
         FROM events WHERE id = $1`,
      [e.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: e.id,
      ts: new Date(e.ts),
      ingested_at: new Date(e.ingestedAt),
      source: 'linux_auth',
      host: 'bastion-01',
      category: 'authentication',
      action: 'ssh_login',
      outcome: 'failure',
      user_name: 'root',
      src_ip: '2001:db8::1',
      src_port: e.srcPort,
      message: e.message,
      fields: e.fields,
    });
  });

  it('stores absent user, IP and port as NULL', async () => {
    const e = event(2);
    delete e.user;
    delete e.srcIp;
    delete e.srcPort;
    await createEventStore(db.pool).insertMany([e]);
    const { rows } = await db.pool.query(
      'SELECT user_name, src_ip, src_port FROM events WHERE id = $1',
      [e.id],
    );
    expect(rows[0]).toEqual({ user_name: null, src_ip: null, src_port: null });
  });

  it('writes 2,500 events in three round trips (at most 1,000 per statement)', async () => {
    const pool = db.pool;
    const spy = vi.spyOn(pool, 'query');
    const events = Array.from({ length: 2500 }, (_, i) => event(i, { host: 'bulk-host' }));
    await createEventStore(pool).insertMany(events);
    expect(spy).toHaveBeenCalledTimes(Math.ceil(2500 / INSERT_CHUNK_SIZE));
    spy.mockRestore();
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM events WHERE host = 'bulk-host'",
    );
    expect(Number(rows[0]?.count)).toBe(2500);
  });

  it('does nothing for an empty batch and needs no pool for it', async () => {
    await expect(createEventStore().insertMany([])).resolves.toBeUndefined();
  });

  it('fails clearly without a pool', async () => {
    await expect(createEventStore().insertMany([event(3)])).rejects.toThrow(
      'no database pool configured',
    );
  });

  it('rejects a batch atomically when one event is invalid', async () => {
    const good = event(4, { host: 'atomic-host' });
    const bad = event(5, { host: 'atomic-host', id: good.id }); // duplicate primary key
    await expect(createEventStore(db.pool).insertMany([good, bad])).rejects.toThrow();
    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT count(*) FROM events WHERE host = 'atomic-host'",
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
