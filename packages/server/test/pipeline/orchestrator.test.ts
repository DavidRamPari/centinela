import { describe, expect, it } from 'vitest';
import { createPipeline } from '../../src/pipeline/index.js';
import { createMemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import {
  actionDetector,
  candidateFor,
  ctx,
  fakeParser,
  recordingPublisher,
  recordingStore,
} from './fakes.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function testPipeline(batchSize = 1000) {
  const eventStore = recordingStore();
  const { detector, seen, watermarks } = actionDetector();
  const alertSink = createMemoryAlertSink();
  const publisher = recordingPublisher();
  const pipeline = createPipeline({
    parsers: new Map([['linux_auth', fakeParser()]]),
    eventStore,
    detector,
    alertSink,
    publisher,
    batchSize,
    now: () => new Date('2026-10-25T12:00:01Z'),
  });
  return { pipeline, eventStore, seen, watermarks, alertSink, publisher };
}

describe('pipeline orchestrator', () => {
  it('rejects every line with `unknown source` when no parser is registered', async () => {
    const pipeline = createPipeline({ parsers: new Map() });
    const summary = await pipeline.ingest(['a', 'b'], ctx);
    expect(summary).toMatchObject({
      accepted: 0,
      rejected: 2,
      rejections: [
        { line: 1, reason: 'unknown source' },
        { line: 2, reason: 'unknown source' },
      ],
    });
  });

  it('the default pipeline rejects sources without a parser with `unknown source`', async () => {
    const summary = await createPipeline().ingest(['{"EventID":1}'], { ...ctx, source: 'sysmon' });
    expect(summary.rejections).toEqual([{ line: 1, reason: 'unknown source' }]);
  });

  it('assigns UUIDv7 ids and ingestedAt, and sorts each batch by event time (stable)', async () => {
    const { pipeline, eventStore, seen } = testPipeline();
    const summary = await pipeline.ingest(
      [
        '2026-10-21T03:12:05Z carol login',
        '2026-10-21T03:12:01Z alice login',
        '2026-10-21T03:12:05Z dave login',
        '2026-10-21T03:12:03Z bob login',
      ],
      ctx,
    );
    expect(summary).toMatchObject({ accepted: 4, rejected: 0 });
    const stored = eventStore.batches.flat();
    expect(stored.map((e) => e.user)).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(seen.map((e) => e.user)).toEqual(['alice', 'bob', 'carol', 'dave']);
    for (const event of stored) {
      expect(event.id).toMatch(UUID_V7);
      expect(event.ingestedAt).toBe('2026-10-25T12:00:01.000Z');
    }
    expect(new Set(stored.map((e) => e.id)).size).toBe(4);
  });

  it('splits input into batches, skips blank lines and strips CR', async () => {
    const { pipeline, eventStore } = testPipeline(2);
    const summary = await pipeline.ingest(
      [
        '2026-10-21T03:00:00Z a login\r',
        '',
        '   ',
        '2026-10-21T03:00:01Z b login',
        '2026-10-21T03:00:02Z c login',
      ],
      ctx,
    );
    expect(summary).toMatchObject({ accepted: 3, rejected: 0 });
    expect(eventStore.batches.map((b) => b.length)).toEqual([2, 1]);
    expect(eventStore.batches[0]?.[0]?.message).toBe('2026-10-21T03:00:00Z a login');
  });

  it('reports rejections with 1-based line numbers, at most 20 samples', async () => {
    const { pipeline } = testPipeline();
    const lines = [
      '2026-10-21T03:00:00Z a login',
      ...Array.from({ length: 25 }, () => 'garbage'),
      'THROW',
    ];
    const summary = await pipeline.ingest(lines, ctx);
    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(26);
    expect(summary.rejections).toHaveLength(20);
    expect(summary.rejections[0]).toEqual({ line: 2, reason: 'not a test line' });
  });

  it('turns a throwing parser into a rejection instead of failing the request', async () => {
    const { pipeline } = testPipeline();
    const summary = await pipeline.ingest(['THROW'], ctx);
    expect(summary.rejections).toEqual([{ line: 1, reason: 'parser error' }]);
  });

  it('upserts candidates, publishes changes and counts created/updated alerts', async () => {
    const { pipeline, alertSink, publisher } = testPipeline();
    const summary = await pipeline.ingest(
      [
        '2026-10-21T03:00:00Z mallory alert',
        '2026-10-21T03:01:00Z mallory alert',
        '2026-10-21T03:02:00Z x login',
      ],
      ctx,
    );
    expect(summary).toMatchObject({ accepted: 3, alertsCreated: 1, alertsUpdated: 0 });
    expect(alertSink.list()).toHaveLength(1);
    expect(alertSink.list()[0]?.count).toBe(2);
    expect(publisher.changes.map((c) => c.type)).toEqual(['alert.created']);

    const again = await pipeline.ingest(['2026-10-21T03:05:00Z mallory alert'], ctx);
    expect(again).toMatchObject({ alertsCreated: 0, alertsUpdated: 1 });
    expect(publisher.changes.map((c) => c.type)).toEqual(['alert.created', 'alert.updated']);
  });

  it('flushes the detector once at the newest event time and stores its candidates', async () => {
    const eventStore = recordingStore();
    const { detector, watermarks } = actionDetector((watermark) => [
      candidateFor({
        id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
        ts: watermark.toISOString(),
        host: 'h',
        user: 'u',
      }),
    ]);
    const pipeline = createPipeline({
      parsers: new Map([['linux_auth', fakeParser()]]),
      eventStore,
      detector,
      batchSize: 1,
    });
    const summary = await pipeline.ingest(
      ['2026-10-21T03:00:09Z a login', '2026-10-21T03:00:01Z b login', 'garbage'],
      ctx,
    );
    expect(watermarks.map((w) => w.toISOString())).toEqual(['2026-10-21T03:00:09.000Z']);
    expect(summary.alertsCreated).toBe(1);
  });

  it('does not flush when nothing was accepted', async () => {
    const { pipeline, watermarks } = testPipeline();
    await pipeline.ingest(['garbage'], ctx);
    expect(watermarks).toEqual([]);
  });

  it('accepts async iterables', async () => {
    const { pipeline } = testPipeline();
    async function* lines() {
      yield await Promise.resolve('2026-10-21T03:00:00Z a login');
      yield await Promise.resolve('2026-10-21T03:00:01Z b login');
    }
    expect((await pipeline.ingest(lines(), ctx)).accepted).toBe(2);
  });

  it('serializes concurrent ingests so batches never interleave', async () => {
    const { pipeline, seen } = testPipeline(1);
    const first = pipeline.ingest(
      ['2026-10-21T03:00:00Z a1 login', '2026-10-21T03:00:01Z a2 login'],
      ctx,
    );
    const second = pipeline.ingest(
      ['2026-10-21T03:00:00Z b1 login', '2026-10-21T03:00:01Z b2 login'],
      ctx,
    );
    await Promise.all([first, second]);
    expect(seen.map((e) => e.user)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('keeps working after a failed ingest', async () => {
    const pipeline = createPipeline({
      parsers: new Map([['linux_auth', fakeParser()]]),
    });
    // The default event store without a pool throws.
    await expect(pipeline.ingest(['2026-10-21T03:00:00Z a login'], ctx)).rejects.toThrow(
      'no database pool configured',
    );
    await expect(pipeline.ingest(['garbage'], ctx)).resolves.toMatchObject({ rejected: 1 });
  });
});
