/**
 * The orchestrator's part of live detection (ARCHITECTURE §6.2), with fakes around it:
 * what waits, what is evaluated when, what is late, what is rejected, and what a call
 * answers.
 */
import type { NormalizedEvent } from '@centinela/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPipeline } from '../../src/pipeline/index.js';
import { createMemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import {
  FUTURE_TIMESTAMP_REASON,
  INVALID_TIMESTAMP_REASON,
  type OrchestratorOptions,
} from '../../src/pipeline/orchestrator.js';
import {
  StreamLimitError,
  type AlertSink,
  type Detector,
  type EventStore,
  type IngestContext,
  type Parser,
  type StreamCounts,
  type StreamKey,
  type StreamRegistry,
} from '../../src/pipeline/types.js';
import { candidateFor, ctx, fakeParser, recordingStore } from './fakes.js';

/** Records every event with the detection time it was evaluated at. */
function recordingDetector() {
  const seen: Array<{ user: string | undefined; ts: string; time: number | undefined }> = [];
  const flushes: string[] = [];
  const detector: Detector = {
    process(event: NormalizedEvent, detectionTime?: number) {
      seen.push({ user: event.user, ts: event.ts, time: detectionTime });
      return event.action === 'alert' ? [candidateFor(event)] : [];
    },
    flush(watermark) {
      flushes.push(watermark.toISOString());
      return [];
    },
  };
  return { detector, seen, flushes, users: () => seen.map((s) => s.user) };
}

function recordingStreams(limitAfter = Number.POSITIVE_INFINITY) {
  const keys: StreamKey[] = [];
  const counts: Array<{ id: string } & StreamCounts> = [];
  const registry: StreamRegistry = {
    resolve(key) {
      if (keys.length >= limitAfter) return Promise.reject(new StreamLimitError(limitAfter));
      keys.push(key);
      return Promise.resolve(`stream-${key.host}`);
    },
    record(id, c) {
      counts.push({ id, ...c });
      return Promise.resolve();
    },
  };
  return { registry, keys, counts };
}

function livePipeline(
  options: OrchestratorOptions & { alertSink?: AlertSink; eventStore?: EventStore } = {},
) {
  const eventStore = recordingStore();
  const recorder = recordingDetector();
  const alertSink = options.alertSink ?? createMemoryAlertSink();
  const pipeline = createPipeline({
    parsers: new Map([['linux_auth', fakeParser()]]),
    eventStore,
    detector: recorder.detector,
    alertSink,
    now: () => new Date('2026-10-25T12:00:01Z'),
    ...options,
  });
  return { pipeline, eventStore, ...recorder };
}

const stored: IngestContext = { ...ctx, ack: 'stored' };
const at = (seconds: number) => new Date(Date.parse('2026-10-25T10:00:00Z') + seconds * 1000);
const line = (seconds: number, user: string, action = 'login') =>
  `${at(seconds).toISOString()} ${user} ${action}`;

afterEach(() => {
  vi.useRealTimers();
});

describe('ack=evaluated (the default)', () => {
  it('evaluates the whole call in time order, also across its batches, and reports nothing pending', async () => {
    const { pipeline, users, flushes } = livePipeline({ batchSize: 2 });
    const summary = await pipeline.ingest(
      [line(5, 'e5'), line(1, 'e1'), line(3, 'e3'), line(2, 'e2'), line(4, 'e4')],
      ctx,
    );
    expect(summary).toMatchObject({ accepted: 5, rejected: 0, pending: 0, late: 0 });
    expect(users()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(flushes).toEqual([at(5).toISOString()]);
    expect(pipeline.stats()).toEqual({
      buffered: 0,
      evaluated: 5,
      late: 0,
      early: 0,
      heldAlerts: 0,
    });
  });

  it('counts the alerts of its own events before answering', async () => {
    const { pipeline } = livePipeline();
    const summary = await pipeline.ingest([line(1, 'mallory', 'alert'), line(2, 'bob')], ctx);
    expect(summary).toMatchObject({ alertsCreated: 1, pending: 0 });
  });
});

describe('ack=stored', () => {
  it('answers with the events still waiting and evaluates them when the horizon passes', async () => {
    const { pipeline, users, eventStore } = livePipeline();
    const first = await pipeline.ingest([line(0, 'a0'), line(4, 'a4', 'alert')], stored);
    expect(first).toMatchObject({ accepted: 2, pending: 2, alertsCreated: 0 });
    expect(eventStore.batches.flat()).toHaveLength(2);
    expect(users()).toEqual([]);

    // Another host, older and newer events: the horizon moves to 6 s.
    const second = await pipeline.ingest([line(2, 'b2'), line(16, 'b16')], {
      ...stored,
      host: 'web-01',
    });
    expect(users()).toEqual(['a0', 'b2', 'a4']);
    // The alert of the first call is created while the second one runs.
    expect(second).toMatchObject({ accepted: 2, pending: 1, alertsCreated: 1 });
    expect(pipeline.stats()).toMatchObject({ buffered: 1, evaluated: 3, late: 0 });
  });

  it('drain() evaluates what is left, in order, and flushes the detector', async () => {
    const { pipeline, users, flushes } = livePipeline();
    await pipeline.ingest([line(3, 'x3'), line(1, 'x1')], stored);
    await pipeline.ingest([line(2, 'y2')], { ...stored, host: 'web-01' });
    expect(users()).toEqual([]);
    await pipeline.drain();
    expect(users()).toEqual(['x1', 'y2', 'x3']);
    expect(flushes).toEqual([at(3).toISOString()]);
    expect(pipeline.stats().buffered).toBe(0);
  });

  it('a call that asks for final counts also releases older events of other streams', async () => {
    const { pipeline, users } = livePipeline();
    await pipeline.ingest([line(1, 's1'), line(9, 's9')], stored);
    const summary = await pipeline.ingest([line(5, 'u5')], { ...ctx, host: 'web-01' });
    expect(users()).toEqual(['s1', 'u5']);
    expect(summary.pending).toBe(0);
    expect(pipeline.stats().buffered).toBe(1);
  });
});

describe('late events', () => {
  it('are evaluated on arrival, before what their batch releases, and counted', async () => {
    const { pipeline, users } = livePipeline({ reorder: { windowMs: 2_000 } });
    await pipeline.ingest([line(0, 'a'), line(10, 'b')], stored); // releases a
    await pipeline.ingest([line(20, 'c')], stored); // releases b
    const summary = await pipeline.ingest([line(4, 'late4'), line(2, 'late2'), line(30, 'd')], {
      ...stored,
      host: 'web-01',
    });
    expect(users()).toEqual(['a', 'b', 'late2', 'late4', 'c']);
    expect(summary).toMatchObject({ accepted: 3, late: 2, pending: 1 });
    expect(pipeline.stats()).toMatchObject({ late: 2, evaluated: 5 });
  });

  it('a file that covers a time already evaluated goes through in its own order', async () => {
    const { pipeline, users } = livePipeline();
    await pipeline.ingest([line(100, 'first-file')], ctx);
    const summary = await pipeline.ingest([line(1, 'o1'), line(3, 'o3'), line(2, 'o2')], ctx);
    expect(users()).toEqual(['first-file', 'o1', 'o2', 'o3']);
    expect(summary).toMatchObject({ late: 3, pending: 0 });
  });
});

describe('timestamps from the future', () => {
  const receivedAt = new Date('2026-10-25T10:00:00Z');

  it('rejects an event dated more than the allowed skew ahead of the receive time', async () => {
    const { pipeline, users, eventStore } = livePipeline();
    const summary = await pipeline.ingest(
      ['2030-01-01T00:00:00Z mallory login', '2026-10-26T10:00:01Z eve login', line(-5, 'ok')],
      { ...ctx, receivedAt },
    );
    expect(summary).toMatchObject({ accepted: 1, rejected: 2 });
    expect(summary.rejections).toEqual([
      { line: 1, reason: FUTURE_TIMESTAMP_REASON },
      { line: 2, reason: FUTURE_TIMESTAMP_REASON },
    ]);
    expect(users()).toEqual(['ok']);
    expect(eventStore.batches.flat().map((e) => e.user)).toEqual(['ok']);
  });

  it('keeps the stored timestamp of an event inside the skew and detects at the receive time', async () => {
    const { pipeline, seen, eventStore, flushes } = livePipeline();
    await pipeline.ingest(['2026-10-25T18:00:00Z clockahead login', line(-60, 'normal')], {
      ...ctx,
      receivedAt,
    });
    expect(eventStore.batches.flat().map((e) => [e.user, e.ts])).toEqual([
      ['normal', '2026-10-25T09:59:00.000Z'],
      ['clockahead', '2026-10-25T18:00:00.000Z'],
    ]);
    expect(seen).toEqual([
      { user: 'normal', ts: '2026-10-25T09:59:00.000Z', time: Date.parse('2026-10-25T09:59:00Z') },
      // Evaluated at 10:00, the receive time: never ahead of the server's clock.
      { user: 'clockahead', ts: '2026-10-25T18:00:00.000Z', time: receivedAt.getTime() },
    ]);
    expect(flushes).toEqual([receivedAt.toISOString()]);
  });

  it('honours a configured skew, including none at all', async () => {
    const { pipeline } = livePipeline({ maxFutureSkewMs: 0 });
    const summary = await pipeline.ingest(['2026-10-25T10:00:00.001Z a login', line(0, 'b')], {
      ...ctx,
      receivedAt,
    });
    expect(summary).toMatchObject({ accepted: 1, rejected: 1 });
  });

  it('rejects a timestamp that is not a date instead of storing it', async () => {
    const broken: Parser = {
      source: 'linux_auth',
      input: 'line',
      parse: (text, context) => {
        const result = fakeParser().parse(`${at(0).toISOString()} x login`, context);
        return result.ok && text === 'bad'
          ? { ok: true, event: { ...result.event, ts: 'not a date' } }
          : result;
      },
    };
    const eventStore = recordingStore();
    const pipeline = createPipeline({ parsers: new Map([['linux_auth', broken]]), eventStore });
    const summary = await pipeline.ingest(['bad', 'good'], ctx);
    expect(summary.rejections).toEqual([{ line: 1, reason: INVALID_TIMESTAMP_REASON }]);
    expect(eventStore.batches.flat()).toHaveLength(1);
  });
});

describe('timestamps the database cannot store', () => {
  it('rejects an event dated before year 1 instead of failing the call', async () => {
    const { pipeline, users, eventStore } = livePipeline();
    const summary = await pipeline.ingest(
      ['0000-06-01T00:00:00Z mallory login', line(1, 'ok'), '0001-01-01T00:00:00Z ancient login'],
      ctx,
    );
    expect(summary).toMatchObject({ accepted: 2, rejected: 1 });
    expect(summary.rejections).toEqual([{ line: 1, reason: INVALID_TIMESTAMP_REASON }]);
    expect(users()).toEqual(['ancient', 'ok']);
    expect(eventStore.batches.flat().map((e) => e.user)).toEqual(['ancient', 'ok']);
  });
});

describe('idle release', () => {
  it('evaluates what is waiting once no batch arrived for the idle time', async () => {
    vi.useFakeTimers();
    const { pipeline, users, flushes } = livePipeline({ reorder: { idleMs: 5_000 } });
    await pipeline.ingest([line(1, 'q1', 'alert'), line(0, 'q0')], stored);
    expect(users()).toEqual([]);

    await vi.advanceTimersByTimeAsync(4_000);
    // A new batch restarts the wait.
    await pipeline.ingest([line(2, 'q2')], stored);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(users()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(users()).toEqual(['q0', 'q1', 'q2']);
    expect(flushes).toEqual([at(2).toISOString()]);
    expect(pipeline.stats()).toMatchObject({ buffered: 0, evaluated: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sets no timer when nothing is waiting, and none after stop()', async () => {
    vi.useFakeTimers();
    const { pipeline, users } = livePipeline({ reorder: { idleMs: 5_000 } });
    await pipeline.ingest([line(1, 'done')], ctx);
    expect(vi.getTimerCount()).toBe(0);

    await pipeline.ingest([line(2, 'waiting')], stored);
    expect(vi.getTimerCount()).toBe(1);
    pipeline.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(users()).toEqual(['done']);
    expect(pipeline.stats().buffered).toBe(1);
  });

  /** A store whose inserts take `ms` once `slow.on` is set, as a database under load. */
  function slowStore(ms: number) {
    const slow = { on: false };
    const eventStore: EventStore = {
      insertMany: () =>
        slow.on ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(),
    };
    return { slow, eventStore };
  }

  it('does not release when a call was still running as the idle time passed: the wait starts again after it', async () => {
    vi.useFakeTimers();
    const { slow, eventStore } = slowStore(6_000);
    const { pipeline, users } = livePipeline({ reorder: { idleMs: 5_000 }, eventStore });
    await pipeline.ingest([line(1, 'a1')], stored);

    // The next call takes six seconds: the timer fires while it runs.
    slow.on = true;
    const running = pipeline.ingest([line(2, 'b2')], { ...stored, host: 'web-01' });
    await vi.advanceTimersByTimeAsync(6_000);
    await running;
    slow.on = false;
    // Its events arrived a moment ago. Released now, an older batch from a slower machine
    // would find them evaluated and be late.
    await vi.advanceTimersByTimeAsync(0);
    expect(users()).toEqual([]);
    const older = await pipeline.ingest([line(0, 'c0')], { ...stored, host: 'db-01' });
    expect(older).toMatchObject({ late: 0, pending: 1 });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(users()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(users()).toEqual(['c0', 'a1', 'b2']);
    expect(pipeline.stats()).toMatchObject({ buffered: 0, evaluated: 3, late: 0 });
  });

  it('stop() also cancels a release that was waiting for a running call', async () => {
    vi.useFakeTimers();
    const { slow, eventStore } = slowStore(6_000);
    const { pipeline, users } = livePipeline({ reorder: { idleMs: 5_000 }, eventStore });
    await pipeline.ingest([line(1, 'a1')], stored);
    slow.on = true;
    const running = pipeline.ingest([line(2, 'b2')], { ...stored, host: 'web-01' });
    await vi.advanceTimersByTimeAsync(5_500);
    pipeline.stop();
    await vi.advanceTimersByTimeAsync(500);
    await running;
    await vi.advanceTimersByTimeAsync(60_000);
    // A clean stop saves the buffer as it is: nothing is evaluated early.
    expect(users()).toEqual([]);
    expect(pipeline.stats().buffered).toBe(2);
  });

  it('reports a failure nobody is waiting for', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const { pipeline } = livePipeline({
      reorder: { idleMs: 1_000 },
      onBackgroundError: (err) => errors.push(err),
    });
    await pipeline.ingest([line(1, 'mallory', 'alert')], stored);
    // The detector breaks while nobody waits: the idle release reports it.
    pipeline.components.detector.process = () => {
      throw new Error('detector is broken');
    };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('detector is broken');
  });

  it('holds the alerts of a failed write and tries again on the idle timer (S12-R08)', async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    let down = true;
    const sink = createMemoryAlertSink();
    const failing: AlertSink = {
      upsert: (batch) =>
        down ? Promise.reject(new Error('database is down')) : sink.upsert(batch),
    };
    const { pipeline } = livePipeline({
      alertSink: failing,
      reorder: { idleMs: 1_000 },
      onAlertWriteError: (failure) => failures.push(failure.error),
    });
    await pipeline.ingest([line(1, 'mallory', 'alert')], stored);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('database is down');
    expect(pipeline.stats().heldAlerts).toBe(1);
    down = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sink.list()).toHaveLength(1);
    // The pipeline keeps working.
    await expect(pipeline.ingest([line(2, 'bob')], ctx)).resolves.toMatchObject({ accepted: 1 });
  });
});

describe('the bound on waiting events', () => {
  it('evaluates the oldest early when the buffer is full, and counts them', async () => {
    const { pipeline, users } = livePipeline({ reorder: { maxEvents: 3 } });
    const summary = await pipeline.ingest(
      [1, 2, 3, 4, 5].map((s) => line(s, `e${s}`)),
      stored,
    );
    expect(users()).toEqual(['e1', 'e2']);
    expect(summary.pending).toBe(3);
    expect(pipeline.stats()).toMatchObject({ buffered: 3, early: 2, late: 0 });
  });
});

describe('streams', () => {
  it('resolves the stream of the call, stores it with the events and records the counts once', async () => {
    const streams = recordingStreams();
    const eventStore = recordingStore();
    const metas: Array<{ streamId: string | null } | undefined> = [];
    const pipeline = createPipeline({
      parsers: new Map([['linux_auth', fakeParser()]]),
      eventStore: {
        insertMany(events, meta) {
          metas.push(meta);
          return eventStore.insertMany(events);
        },
      },
      streams: streams.registry,
      batchSize: 2,
      reorder: { windowMs: 2_000 },
    });
    await pipeline.ingest([line(50, 'x')], {
      ...ctx,
      stream: { kind: 'upload', tokenId: null },
    });
    const summary = await pipeline.ingest([line(3, 'a'), 'garbage', line(1, 'b'), line(60, 'c')], {
      ...stored,
      host: 'web-01',
      stream: { kind: 'token', tokenId: '0198f3a1-0000-7000-8000-000000000042' },
    });
    expect(summary).toMatchObject({ accepted: 3, rejected: 1, late: 2 });
    expect(streams.keys).toEqual([
      { kind: 'upload', tokenId: null, source: 'linux_auth', host: 'bastion-01' },
      {
        kind: 'token',
        tokenId: '0198f3a1-0000-7000-8000-000000000042',
        source: 'linux_auth',
        host: 'web-01',
      },
    ]);
    expect(metas).toEqual([
      { streamId: 'stream-bastion-01' },
      { streamId: 'stream-web-01' },
      { streamId: 'stream-web-01' },
    ]);
    expect(streams.counts).toEqual([
      {
        id: 'stream-bastion-01',
        accepted: 1,
        rejected: 0,
        late: 0,
        lastEventTs: at(50),
        at: ctx.receivedAt,
      },
      {
        id: 'stream-web-01',
        accepted: 3,
        rejected: 1,
        late: 2,
        lastEventTs: at(60),
        at: ctx.receivedAt,
      },
    ]);
  });

  it('is the command line when the caller does not say who delivers', async () => {
    const streams = recordingStreams();
    const pipeline = createPipeline({
      parsers: new Map([['linux_auth', fakeParser()]]),
      eventStore: recordingStore(),
      streams: streams.registry,
    });
    await pipeline.ingest([line(1, 'a')], ctx);
    expect(streams.keys).toEqual([
      { kind: 'cli', tokenId: null, source: 'linux_auth', host: 'bastion-01' },
    ]);
  });

  it('refuses the call when the token already owns the maximum of streams', async () => {
    const streams = recordingStreams(0);
    const eventStore = recordingStore();
    const pipeline = createPipeline({
      parsers: new Map([['linux_auth', fakeParser()]]),
      eventStore,
      streams: streams.registry,
    });
    await expect(pipeline.ingest([line(1, 'a')], ctx)).rejects.toBeInstanceOf(StreamLimitError);
    expect(eventStore.batches).toEqual([]);
  });
});
