/**
 * A failed alert write (S12-R08, closed in S11): the events of that step were stored and
 * the detector has counted them, so nothing would raise their alerts again. The pipeline
 * holds them and writes them with the next write, in order; a candidate the database
 * refuses for what it is gets dropped instead of blocking the others; an ingest call
 * whose events were stored does not fail; no checkpoint is saved while alerts are held.
 */
import { DEFAULT_SEED, DEFAULT_START, generate, type GenerationResult } from '@centinela/loggen';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAlertSink } from '../../src/db/alert-sink.js';
import { createMemoryAlertSink, type MemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import {
  AlertWriteError,
  createOrchestrator,
  isTransientWriteError,
  MAX_HELD_ALERTS,
  type AlertWriteFailure,
  type OrchestratorOptions,
} from '../../src/pipeline/orchestrator.js';
import type { AlertCandidate, IngestContext } from '../../src/pipeline/types.js';
import { actionDetector, fakeParser, recordingPublisher, recordingStore } from './fakes.js';
import {
  arrivalOrder,
  createLiveRun,
  cutIntoBatches,
  memoryCheckpoints,
  memoryReader,
  outcomes,
  referenceRun,
  seeded,
  type AlertOutcome,
} from './live.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/** A dropped connection: not an answer from PostgreSQL. */
const DROPPED = new Error('Connection terminated unexpectedly');
/** PostgreSQL ended the transaction to break a deadlock with a triage. */
const DEADLOCK = Object.assign(new Error('deadlock detected'), {
  code: '40P01',
  severity: 'ERROR',
});
/** PostgreSQL refuses the data itself: writing it again will not help. */
const BAD_DATA = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
  code: '22021',
  severity: 'ERROR',
});

/** The memory sink, failing the calls `fails` names before anything is written. */
function failingSink(fails: (call: number, batch: AlertCandidate[]) => unknown) {
  const inner = createMemoryAlertSink();
  let calls = 0;
  const sink: MemoryAlertSink = {
    ...inner,
    upsert(batch) {
      calls += 1;
      const error = fails(calls, batch);
      // The errors are what pg and Node throw: objects that may not be `Error`s.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return error === undefined ? inner.upsert(batch) : Promise.reject(error);
    },
  };
  return { sink, inner, calls: () => calls };
}

describe('which failed writes are worth repeating', () => {
  it.each([
    ['a dropped connection', DROPPED, true],
    ['a socket error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), true],
    ['a deadlock', DEADLOCK, true],
    ['a serialization failure', { code: '40001', severity: 'ERROR' }, true],
    ['too many connections', { code: '53300', severity: 'FATAL' }, true],
    ['an administrator shutdown', { code: '57P01', severity: 'FATAL' }, true],
    ['a NUL byte in text', BAD_DATA, false],
    ['a constraint violation', { code: '23514', severity: 'ERROR' }, false],
    ['a thrown string', 'boom', true],
    // S11-R02: these say nothing about the data, so the alerts are held, not dropped.
    ['a read-only transaction (a failover)', { code: '25006', severity: 'ERROR' }, true],
    ['a lock timeout', { code: '55P03', severity: 'ERROR' }, true],
    ['a refused password (a rotated secret)', { code: '28P01', severity: 'FATAL' }, true],
    ['an internal error', { code: 'XX000', severity: 'ERROR' }, true],
    ['a missing table', { code: '42P01', severity: 'ERROR' }, true],
    // A value too large for an index is the data: holding it would block every alert.
    ['an index row too large', { code: '54000', severity: 'ERROR' }, false],
  ])('%s: %s', (_name, error, transient) => {
    expect(isTransientWriteError(error)).toBe(transient);
  });
});

describe('a failed alert write on the demo data, delivered live', () => {
  let sample: GenerationResult;
  let reference: AlertOutcome[];

  beforeAll(async () => {
    sample = generate({
      seed: DEFAULT_SEED,
      days: 3,
      startMs: Date.parse(DEFAULT_START),
      small: true,
    });
    reference = await referenceRun(sample);
  }, 120_000);

  async function deliverWith(fails: (call: number) => unknown) {
    const random = seeded(7);
    const batches = arrivalOrder(cutIntoBatches(sample, random), random, 4000);
    const failing = failingSink((call) => fails(call));
    const failures: AlertWriteFailure[] = [];
    const run = createLiveRun({
      alertSink: failing.sink,
      onAlertWriteError: (failure) => failures.push(failure),
      reorder: { windowMs: 10_000, idleMs: Number.POSITIVE_INFINITY },
    });
    let stored = 0;
    // Every call resolves: the events were stored, so no sender is told to send again.
    for (const batch of batches) stored += (await run.deliver(batch)).accepted;
    await run.pipeline.drain();
    return { alerts: outcomes(failing.inner), failures, stored, run, calls: failing.calls() };
  }

  it('fails once: every alert of the run without failures exists, none doubled', async () => {
    const { alerts, failures, stored, run } = await deliverWith((call) =>
      call === 5 ? DROPPED : undefined,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: DROPPED, dropped: [] });
    expect(failures[0]?.held).toBeGreaterThan(0);
    expect(stored).toBe(sample.lines.length);
    expect(run.pipeline.stats().heldAlerts).toBe(0);
    expect(alerts).toEqual(reference);
  }, 120_000);

  it('fails for several requests in a row: the alerts are written once it recovers', async () => {
    const { alerts, failures, stored, calls } = await deliverWith((call) =>
      call >= 3 && call <= 40 ? DEADLOCK : undefined,
    );
    expect(failures).toHaveLength(38);
    expect(failures.every((failure) => failure.dropped.length === 0)).toBe(true);
    // The held alerts grew while the writes failed.
    expect(failures.at(-1)?.held).toBeGreaterThan(failures[0]?.held ?? 0);
    expect(calls).toBeGreaterThan(40);
    expect(stored).toBe(sample.lines.length);
    expect(alerts).toEqual(reference);
  }, 120_000);
});

describe('the pipeline around a failed write', () => {
  const T0 = Date.parse('2026-10-25T12:00:00Z');
  const at = (ms: number) => new Date(T0 + ms).toISOString();

  function setup(
    fails: (call: number, batch: AlertCandidate[]) => unknown,
    options: OrchestratorOptions = {},
  ) {
    const failing = failingSink(fails);
    const store = recordingStore();
    const failures: AlertWriteFailure[] = [];
    const pipeline = createOrchestrator(
      {
        parsers: new Map([['linux_auth', fakeParser()]]),
        eventStore: store,
        detector: actionDetector().detector,
        alertSink: failing.sink,
        publisher: recordingPublisher(),
      },
      {
        reorder: { windowMs: 10_000, idleMs: Number.POSITIVE_INFINITY },
        onAlertWriteError: (failure) => failures.push(failure),
        ...options,
      },
    );
    const send = (
      host: string,
      lines: string[],
      receivedMs: number,
      ack: 'stored' | 'evaluated',
    ) => {
      const ctx: IngestContext = {
        source: 'linux_auth',
        host,
        receivedAt: new Date(T0 + receivedMs),
        timezone: 'UTC',
        ack,
      };
      return pipeline.ingest(lines, ctx);
    };
    const storedHosts = () => store.batches.flat().map((event) => `${event.host}:${event.user}`);
    return { pipeline, failing, failures, send, storedHosts };
  }

  it('a sender answered with ack=stored loses nothing when another request hits the failure', async () => {
    let broken = true;
    const { pipeline, failing, failures, send, storedHosts } = setup(() =>
      broken ? DROPPED : undefined,
    );
    // Machine A: an event that raises an alert, answered once stored.
    const a = await send('web-01', [`${at(0)} alice alert`], 1000, 'stored');
    expect(a).toMatchObject({ accepted: 1, pending: 1 });
    // Machine B, twenty seconds later: its request releases A's event and the write fails.
    const b = await send('db-01', [`${at(20_000)} bob login`], 21_000, 'stored');
    expect(b).toMatchObject({ accepted: 1 });
    expect(failures).toEqual([{ error: DROPPED, held: 1, dropped: [] }]);
    expect(failing.inner.list()).toEqual([]);

    broken = false;
    await send('db-01', [`${at(40_000)} bob logout`], 41_000, 'stored');
    expect(failing.inner.list().map((alert) => alert.dedupKey)).toEqual([
      '0f6c3f5e-1d2b-4c3a-9e8f-7a6b5c4d3e2f|web-01|alice',
    ]);
    // B was not told to send again: every event is stored once.
    expect(storedHosts()).toEqual(['web-01:alice', 'db-01:bob', 'db-01:bob']);
    expect(pipeline.stats().heldAlerts).toBe(0);
  });

  it('drops a candidate the database refuses for what it is, and writes the others', async () => {
    const { failing, failures, send } = setup((_call, batch) =>
      batch.some((candidate) => candidate.dedupKey.endsWith('|mallory')) ? BAD_DATA : undefined,
    );
    const summary = await send(
      'web-01',
      [`${at(0)} alice alert`, `${at(1000)} mallory alert`, `${at(2000)} carol alert`],
      3000,
      'evaluated',
    );
    expect(summary).toMatchObject({ accepted: 3, alertsCreated: 2 });
    expect(failures).toEqual([
      {
        error: BAD_DATA,
        held: 0,
        dropped: [
          {
            ruleId: '0f6c3f5e-1d2b-4c3a-9e8f-7a6b5c4d3e2f',
            dedupKey: '0f6c3f5e-1d2b-4c3a-9e8f-7a6b5c4d3e2f|web-01|mallory',
          },
        ],
      },
    ]);
    expect(failing.inner.list().map((alert) => alert.entities.users)).toEqual([
      ['alice'],
      ['carol'],
    ]);
  });

  it('holds what follows a refused candidate when the next write fails for another reason', async () => {
    const { failing, failures, send, pipeline } = setup((call, batch) => {
      if (batch.some((candidate) => candidate.dedupKey.endsWith('|mallory'))) return BAD_DATA;
      // Calls: 1 the whole batch (refused), 2 alice alone, 3 mallory alone, 4 carol alone.
      return call === 4 ? DEADLOCK : undefined;
    });
    await send(
      'web-01',
      [`${at(0)} alice alert`, `${at(1000)} mallory alert`, `${at(2000)} carol alert`],
      3000,
      'evaluated',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: DEADLOCK, held: 1 });
    expect(failures[0]?.dropped.map((d) => d.dedupKey.split('|')[2])).toEqual(['mallory']);
    expect(failing.inner.list().map((alert) => alert.entities.users)).toEqual([['alice']]);
    await pipeline.drain();
    expect(failing.inner.list().map((alert) => alert.entities.users)).toEqual([
      ['alice'],
      ['carol'],
    ]);
  });

  it('saves no checkpoint while alerts are held, and saves once they are written', async () => {
    let broken = true;
    const checkpoints = memoryCheckpoints();
    const { pipeline, failing, send } = setup(() => (broken ? DEADLOCK : undefined));
    const withCheckpoint = createOrchestrator(
      { ...pipeline.components, checkpoints, eventReader: memoryReader([]) },
      { reorder: { windowMs: 10_000, idleMs: Number.POSITIVE_INFINITY } },
    );
    void send;
    expect(await withCheckpoint.restore()).toMatchObject({ restored: false });
    const savesAtStart = checkpoints.saves;
    await withCheckpoint.ingest([`${at(0)} alice alert`], {
      source: 'linux_auth',
      host: 'web-01',
      receivedAt: new Date(T0 + 1000),
      timezone: 'UTC',
    });
    expect(withCheckpoint.stats().heldAlerts).toBe(1);
    expect(await withCheckpoint.checkpoint()).toBe(false);
    expect(checkpoints.saves).toBe(savesAtStart);

    broken = false;
    expect(await withCheckpoint.checkpoint()).toBe(true);
    expect(checkpoints.saves).toBe(savesAtStart + 1);
    expect(failing.inner.list()).toHaveLength(1);
  });

  it('drain() rejects while alerts are still held, so a command-line run does not end quietly', async () => {
    let broken = true;
    const { pipeline, failing, send } = setup(() => (broken ? DROPPED : undefined));
    await send('web-01', [`${at(0)} alice alert`], 1000, 'evaluated');
    await expect(pipeline.drain()).rejects.toBeInstanceOf(AlertWriteError);
    await expect(pipeline.drain()).rejects.toMatchObject({ held: 1, cause: DROPPED });
    broken = false;
    await pipeline.drain();
    expect(failing.inner.list()).toHaveLength(1);
  });

  it('writes held alerts on the idle timer when nothing else arrives', async () => {
    let broken = true;
    const scheduled: Array<() => void> = [];
    const timers = {
      set: (callback: () => void) => scheduled.push(callback),
      clear: () => undefined,
    };
    const { pipeline, failing, send } = setup(() => (broken ? DROPPED : undefined), {
      reorder: { windowMs: 10_000, idleMs: 5_000 },
      timers,
    });
    await send('web-01', [`${at(0)} alice alert`], 1000, 'evaluated');
    expect(failing.inner.list()).toEqual([]);
    broken = false;
    // The timer was armed for the held alert although no event waits in the buffer.
    expect(scheduled.length).toBeGreaterThan(0);
    scheduled.at(-1)?.();
    await pipeline.checkpoint(); // waits for the idle task in the queue
    expect(failing.inner.list()).toHaveLength(1);
  });

  it(`keeps at most ${MAX_HELD_ALERTS} alerts and drops the oldest past that`, async () => {
    let broken = true;
    const { pipeline, failing, failures, send } = setup(() => (broken ? DROPPED : undefined));
    const lines = Array.from(
      { length: MAX_HELD_ALERTS + 5 },
      (_, i) => `${at(i)} user${String(i).padStart(5, '0')} alert`,
    );
    await send('web-01', lines, MAX_HELD_ALERTS + 10_000, 'evaluated');
    expect(failures.at(-1)?.held).toBe(MAX_HELD_ALERTS);
    expect(failures.at(-1)?.dropped.map((d) => d.dedupKey.split('|')[2])).toEqual([
      'user00000',
      'user00001',
      'user00002',
      'user00003',
      'user00004',
    ]);
    broken = false;
    await pipeline.drain();
    expect(failing.inner.list()).toHaveLength(MAX_HELD_ALERTS);
  });
});

describe('a write PostgreSQL refuses for a while, not for its data (S11-R02)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  it('holds the alerts while the database is read-only and writes them once it is not', async () => {
    // A standby during a failover, or default_transaction_read_only set for maintenance.
    const readOnly = new pg.Pool({
      connectionString: db.databaseUrl,
      max: 1,
      options: `-c search_path=${db.schema} -c default_transaction_read_only=on`,
    });
    try {
      let failover = true;
      const writable = createPgAlertSink(db.pool);
      const standby = createPgAlertSink(readOnly);
      const failures: AlertWriteFailure[] = [];
      const pipeline = createOrchestrator(
        {
          parsers: new Map([['linux_auth', fakeParser()]]),
          eventStore: recordingStore(),
          detector: actionDetector().detector,
          alertSink: { upsert: (batch) => (failover ? standby : writable).upsert(batch) },
          publisher: recordingPublisher(),
        },
        {
          reorder: { windowMs: 0, idleMs: Number.POSITIVE_INFINITY },
          onAlertWriteError: (failure) => failures.push(failure),
        },
      );
      const at = '2026-10-25T12:00:00.000Z';
      await pipeline.ingest([`${at} alice alert`, `${at} bob alert`], {
        source: 'linux_auth',
        host: 'web-01',
        receivedAt: new Date(at),
        timezone: 'UTC',
      });
      expect(
        failures.map((f) => [(f.error as { code?: unknown }).code, f.held, f.dropped.length]),
      ).toEqual([['25006', 2, 0]]);

      failover = false;
      await pipeline.drain();
      const { rows } = await db.pool.query<{ dedup_key: string }>(
        'SELECT dedup_key FROM alerts ORDER BY dedup_key',
      );
      expect(rows.map((row) => row.dedup_key.split('|')[2])).toEqual(['alice', 'bob']);
    } finally {
      await readOnly.end();
    }
  });
});
