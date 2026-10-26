import { alertSchema, type Alert } from '@centinela/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAlertSink, MAX_ENTITY_VALUES } from '../../src/db/alert-sink.js';
import { getAlert, triageAlert } from '../../src/db/alerts.js';
import { createMemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import type { AlertCandidate } from '../../src/pipeline/types.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RULES, testCandidate } from '../helpers/seed.js';

const NOW = new Date('2026-10-25T12:00:00Z');
const now = () => NOW;

/** A dedup key no other test uses, so tests sharing the schema stay independent. */
function uniqueKey(): string {
  return `${RULES.notInSudoers.id}|bastion-01|${uuidv7()}`;
}

describe('PostgreSQL alert sink', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  async function linkedEvents(alertId: string): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*) FROM alert_events WHERE alert_id = $1',
      [alertId],
    );
    return Number(rows[0]?.count);
  }

  it('creates schema-valid alerts carrying the rule snapshot and links their events', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const candidate = testCandidate({
      rule: RULES.suspiciousAgent,
      dedupKey: uniqueKey(),
      firstSeen: '2026-10-21T03:00:00Z',
      eventIds: [uuidv7(), uuidv7()],
    });
    const { created, updated } = await sink.upsert([candidate]);
    expect(updated).toEqual([]);
    const alert = alertSchema.parse(created[0]);
    expect(alert).toMatchObject({
      ruleId: RULES.suspiciousAgent.id,
      ruleType: 'sigma',
      status: 'new',
      count: 1,
      author: RULES.suspiciousAgent.author,
      ruleUrl: RULES.suspiciousAgent.url,
      license: 'DRL-1.1',
      techniques: ['T1190'],
      firstSeen: '2026-10-21T03:00:00.000Z',
      createdAt: NOW.toISOString(),
    });
    expect(await getAlert(db.pool, alert.id)).toEqual(alert);
    expect(await linkedEvents(alert.id)).toBe(2);
  });

  it('folds a match within 15 minutes of lastSeen into the open alert', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    const { created } = await sink.upsert([
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:00:00Z' }),
    ]);
    const { created: none, updated } = await sink.upsert([
      testCandidate({
        dedupKey,
        firstSeen: '2026-10-21T03:15:00Z',
        ips: ['198.51.100.23'],
        users: ['admin'],
      }),
    ]);
    expect(none).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      id: created[0]?.id,
      count: 2,
      firstSeen: '2026-10-21T03:00:00.000Z',
      lastSeen: '2026-10-21T03:15:00.000Z',
      entities: {
        ips: ['203.0.113.45', '198.51.100.23'],
        users: ['root', 'admin'],
        hosts: ['bastion-01'],
      },
    });
    expect(await getAlert(db.pool, created[0]?.id ?? '')).toEqual(updated[0]);
    expect(await linkedEvents(created[0]?.id ?? '')).toBe(2);
  });

  it('creates a new alert after the suppression window', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    await sink.upsert([testCandidate({ dedupKey, firstSeen: '2026-10-21T03:00:00Z' })]);
    const { created } = await sink.upsert([
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:15:00.001Z' }),
    ]);
    expect(created).toHaveLength(1);
  });

  it('never folds into a closed alert, even inside the window', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    const { created } = await sink.upsert([
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:00:00Z' }),
    ]);
    const first = created[0];
    if (!first) throw new Error('no alert');
    await triageAlert(db.pool, first.id, { status: 'closed', resolution: 'benign' });
    const again = await sink.upsert([
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:01:00Z' }),
    ]);
    expect(again.created).toHaveLength(1);
    expect(again.created[0]?.id).not.toBe(first.id);
    expect((await getAlert(db.pool, first.id))?.count).toBe(1);
  });

  it('folds into an acknowledged alert', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    const { created } = await sink.upsert([
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:00:00Z' }),
    ]);
    await triageAlert(db.pool, created[0]?.id ?? '', { status: 'acknowledged' });
    const { updated } = await sink.upsert([
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:05:00Z' }),
    ]);
    expect(updated[0]).toMatchObject({ status: 'acknowledged', count: 2 });
  });

  it('reports an alert created and updated in the same call only as created', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    const { created, updated } = await sink.upsert([
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:00:00Z' }),
      testCandidate({ dedupKey, firstSeen: '2026-10-21T03:01:00Z' }),
    ]);
    expect(updated).toEqual([]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ count: 2, lastSeen: '2026-10-21T03:01:00.000Z' });
    expect(await getAlert(db.pool, created[0]?.id ?? '')).toEqual(created[0]);
  });

  it('links at most 100 events per alert and caps each entity list', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    const candidates = Array.from({ length: 150 }, (_, i) =>
      testCandidate({
        dedupKey,
        firstSeen: new Date(Date.parse('2026-10-21T03:00:00Z') + i * 1000).toISOString(),
        ips: [`198.18.${Math.floor(i / 250)}.${i % 250}`],
        users: [`user${i}`],
      }),
    );
    await sink.upsert(candidates.slice(0, 60));
    const { updated } = await sink.upsert(candidates.slice(60));
    const alert = updated[0];
    expect(alert?.count).toBe(150);
    expect(alert?.entities.ips).toHaveLength(MAX_ENTITY_VALUES);
    expect(alert?.entities.users).toHaveLength(MAX_ENTITY_VALUES);
    expect(await linkedEvents(alert?.id ?? '')).toBe(100);
  });

  it('serializes concurrent sinks (two processes) so one dedup key gets one alert', async () => {
    const a = createPgAlertSink(db.pool, { now });
    const b = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 === 0 ? a : b).upsert([
          testCandidate({ dedupKey, firstSeen: `2026-10-21T03:0${i}:00Z` }),
        ]),
      ),
    );
    expect(results.flatMap((r) => r.created)).toHaveLength(1);
    const { rows } = await db.pool.query<{ count: number }>(
      'SELECT count FROM alerts WHERE dedup_key = $1',
      [dedupKey],
    );
    expect(rows).toEqual([{ count: 6 }]);
  });

  it('rolls back the whole call when a write fails', async () => {
    const sink = createPgAlertSink(db.pool, { now });
    const dedupKey = uniqueKey();
    const bad: AlertCandidate = {
      ...testCandidate({ dedupKey: uniqueKey(), firstSeen: '2026-10-21T03:00:00Z' }),
      eventIds: ['not-a-uuid'],
    };
    await expect(
      sink.upsert([testCandidate({ dedupKey, firstSeen: '2026-10-21T03:00:00Z' }), bad]),
    ).rejects.toThrow();
    const { rows } = await db.pool.query('SELECT 1 FROM alerts WHERE dedup_key = $1', [dedupKey]);
    expect(rows).toEqual([]);
  });

  it('gives the same alerts as the in-memory sink for the same candidates', async () => {
    const pg = createPgAlertSink(db.pool, { now });
    const memory = createMemoryAlertSink({ now });
    const keys = [uniqueKey(), uniqueKey()];
    const times = ['03:00', '03:10', '03:40', '03:41', '03:50', '04:20', '04:30'];
    const batches = times.map((time, i) => [
      testCandidate({
        dedupKey: keys[i % 2],
        firstSeen: `2026-10-21T${time}:00.000Z`,
        users: [`u${i}`],
      }),
    ]);
    const strip = ({ id: _id, ...rest }: Alert) => rest;
    for (const batch of batches) {
      const [fromPg, fromMemory] = await Promise.all([pg.upsert(batch), memory.upsert(batch)]);
      expect(fromPg.created.map(strip)).toEqual(fromMemory.created.map(strip));
      expect(fromPg.updated.map(strip)).toEqual(fromMemory.updated.map(strip));
    }
  });
});
