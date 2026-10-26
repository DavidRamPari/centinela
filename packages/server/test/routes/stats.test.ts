import { problemSchema, statsOverviewResponseSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAlertSink } from '../../src/db/alert-sink.js';
import { triageAlert } from '../../src/db/alerts.js';
import { createEventStore } from '../../src/db/events-write.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RULES, testCandidate, testEvent } from '../helpers/seed.js';

const DAY = '2026-10-21';
const RANGE = `from=${DAY}T00:00:00Z&to=${DAY}T23:59:59Z`;

describe('GET /api/stats/overview', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
    await createEventStore(db.pool).insertMany([
      testEvent({ ts: `${DAY}T03:05:00.000Z`, srcIp: '203.0.113.45', user: 'root' }),
      testEvent({ ts: `${DAY}T03:20:00.000Z`, srcIp: '203.0.113.45', user: 'admin' }),
      testEvent({ ts: `${DAY}T04:10:00.000Z`, srcIp: '198.51.100.23', user: 'admin' }),
      testEvent({ ts: `${DAY}T04:11:00.000Z`, srcIp: undefined, user: undefined }),
      // Outside the range.
      testEvent({ ts: '2026-10-22T00:00:00.000Z', srcIp: '192.0.2.1', user: 'other' }),
    ]);
    const sink = createPgAlertSink(db.pool);
    const { created } = await sink.upsert([
      testCandidate({
        rule: RULES.bruteforce,
        firstSeen: `${DAY}T03:05:00Z`,
        lastSeen: `${DAY}T03:20:00Z`,
      }),
      testCandidate({ rule: RULES.notInSudoers, host: 'db-01', firstSeen: `${DAY}T04:10:00Z` }),
      testCandidate({ rule: RULES.notInSudoers, host: 'db-02', firstSeen: `${DAY}T04:12:00Z` }),
      testCandidate({ rule: RULES.removed, firstSeen: '2026-10-23T00:00:00Z' }),
    ]);
    await triageAlert(db.pool, created[1]?.id ?? '', { status: 'acknowledged' });
  });
  afterAll(() => db.cleanup());

  async function stats(query: string) {
    const res = await request(app).get(`/api/stats/overview?${query}`).expect(200);
    return statsOverviewResponseSchema.parse(res.body);
  }

  it('counts events and alerts in the range, by level and status', async () => {
    const body = await stats(RANGE);
    expect(body.events).toBe(4);
    expect(body.alerts).toEqual({
      total: 3,
      byLevel: { informational: 0, low: 0, medium: 2, high: 1, critical: 0 },
      byStatus: { new: 2, acknowledged: 1, closed: 0 },
    });
  });

  it('buckets the time series with date_bin (1h by default)', async () => {
    const body = await stats(RANGE);
    expect(body.eventsOverTime).toEqual([
      { t: `${DAY}T03:00:00.000Z`, count: 2 },
      { t: `${DAY}T04:00:00.000Z`, count: 2 },
    ]);
    expect(body.alertsOverTime).toEqual([
      { t: `${DAY}T03:00:00.000Z`, count: 1 },
      { t: `${DAY}T04:00:00.000Z`, count: 2 },
    ]);
  });

  it.each([
    ['5m', [`${DAY}T03:05:00.000Z`, `${DAY}T03:20:00.000Z`, `${DAY}T04:10:00.000Z`]],
    ['1d', [`${DAY}T00:00:00.000Z`]],
  ])('aligns %s buckets to the Unix epoch', async (bucket, starts) => {
    const body = await stats(`${RANGE}&bucket=${bucket}`);
    expect(body.eventsOverTime.map((b) => b.t)).toEqual(starts);
  });

  it('lists the top source IPs, users and rules', async () => {
    const body = await stats(RANGE);
    expect(body.topSourceIps).toEqual([
      { ip: '203.0.113.45', count: 2 },
      { ip: '198.51.100.23', count: 1 },
    ]);
    expect(body.topUsers).toEqual([
      { user: 'admin', count: 2 },
      { user: 'root', count: 1 },
    ]);
    expect(body.topRules).toEqual([
      { ruleId: RULES.notInSudoers.id, title: RULES.notInSudoers.title, level: 'medium', count: 2 },
      { ruleId: RULES.bruteforce.id, title: RULES.bruteforce.title, level: 'high', count: 1 },
    ]);
  });

  it('defaults to the last 24 hours (nothing here is that recent)', async () => {
    const body = await stats('');
    expect(body.events).toBe(0);
    expect(body.eventsOverTime).toEqual([]);
    expect(body.alerts.total).toBe(0);
  });

  it.each([
    ['an unknown bucket', 'bucket=2h'],
    ['`from` after `to`', `from=${DAY}T10:00:00Z&to=${DAY}T09:00:00Z`],
    ['an invalid date', 'from=yesterday'],
  ])('answers 400 for %s', async (_name, query) => {
    const res = await request(app).get(`/api/stats/overview?${query}`).expect(400);
    expect(problemSchema.parse(res.body).status).toBe(400);
  });
});
