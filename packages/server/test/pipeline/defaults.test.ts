/**
 * `createPipeline()` defaults once S4 is in: with a pool, alerts go to PostgreSQL and the
 * default detector honours `rule_state` (as `npm run ingest` relies on); the `prepare`
 * hook runs before any batch and is retried after a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveRuleState } from '../../src/db/rule-state.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RULES } from '../helpers/seed.js';
import { actionDetector, ctx, fakeParser, recordingStore } from './fakes.js';

const SUDO = (second: number) =>
  `2026-10-25T14:03:${String(second).padStart(2, '0')}.000000+00:00 db-01 sudo[1]:   intern : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/bin/ls`;

describe('pipeline defaults with a database', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  async function alertCount(): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>('SELECT count(*) FROM alerts');
    return Number(rows[0]?.count);
  }

  it('stores events and alerts in PostgreSQL', async () => {
    const pipeline = createPipeline({ pool: db.pool });
    const summary = await pipeline.ingest([SUDO(1)], { ...ctx, host: 'db-01' });
    expect(summary).toMatchObject({ accepted: 1, alertsCreated: 1 });
    expect(await alertCount()).toBe(1);
  });

  it('loads rule_state into the default detector before the first batch', async () => {
    await saveRuleState(db.pool, RULES.notInSudoers.id, false);
    const pipeline = createPipeline({ pool: db.pool });
    const summary = await pipeline.ingest([SUDO(40)], { ...ctx, host: 'db-01' });
    expect(summary).toMatchObject({ accepted: 1, alertsCreated: 0, alertsUpdated: 0 });
    expect(await alertCount()).toBe(1);
  });
});

describe('pipeline prepare hook', () => {
  it('runs before the first line is processed and on every run', async () => {
    const order: string[] = [];
    const eventStore = recordingStore();
    const pipeline = createPipeline({
      parsers: new Map([['linux_auth', fakeParser()]]),
      eventStore: {
        insertMany: (events) => {
          order.push('store');
          return eventStore.insertMany(events);
        },
      },
      detector: actionDetector().detector,
      prepare: () => {
        order.push('prepare');
        return Promise.resolve();
      },
    });
    await pipeline.ingest(['2026-10-25T12:00:00Z root login'], ctx);
    await pipeline.ingest(['2026-10-25T12:00:01Z root login'], ctx);
    expect(order).toEqual(['prepare', 'store', 'prepare', 'store']);
  });

  it('fails the run when prepare fails, and the next run tries again', async () => {
    let attempts = 0;
    const pipeline = createPipeline({
      parsers: new Map([['linux_auth', fakeParser()]]),
      eventStore: recordingStore(),
      detector: actionDetector().detector,
      prepare: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('database down')) : Promise.resolve();
      },
    });
    await expect(pipeline.ingest(['2026-10-25T12:00:00Z root login'], ctx)).rejects.toThrow(
      'database down',
    );
    const summary = await pipeline.ingest(['2026-10-25T12:00:00Z root login'], ctx);
    expect(summary.accepted).toBe(1);
  });
});
