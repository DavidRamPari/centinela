/**
 * Helpers for the live-detection tests (PLAN S12): cut the demo data into the batches
 * machines would send, deliver them in a seeded shuffle, and compare the alerts of two
 * runs.
 */
import { join } from 'node:path';
import type { Alert, NormalizedEvent } from '@centinela/shared';
import { FILE_SOURCES, type GenerationResult, type GeneratedLine } from '@centinela/loggen';
import { createDetector } from '../../src/detection/index.js';
import { repoRoot } from '../../src/paths.js';
import { createPipeline, type Pipeline, type PipelineOptions } from '../../src/pipeline/index.js';
import { createMemoryAlertSink, type MemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import type {
  Checkpoint,
  CheckpointStore,
  EventReader,
  EventStore,
  IngestSummary,
} from '../../src/pipeline/types.js';

export const RULES_DIR = join(repoRoot, 'rules');
/** After every generated event, so nothing is clamped or rejected as a future timestamp. */
export const RECEIVED_AT = new Date('2026-11-01T00:00:00Z');

/** Mulberry32: a small seeded generator, enough to shuffle batches reproducibly. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StreamBatch {
  /** `host/file`, the stream's name. */
  stream: string;
  host: string;
  source: (typeof FILE_SOURCES)[keyof typeof FILE_SOURCES];
  lines: string[];
  /** Event time of the first and the last line (epoch ms). */
  fromMs: number;
  toMs: number;
}

const streamOf = (line: GeneratedLine) => `${line.host}/${line.file}`;

/** Each stream's lines, in the order they were written. */
export function linesByStream(sample: GenerationResult): Map<string, GeneratedLine[]> {
  const streams = new Map<string, GeneratedLine[]>();
  for (const line of sample.lines) {
    const list = streams.get(streamOf(line));
    if (list) list.push(line);
    else streams.set(streamOf(line), [line]);
  }
  return streams;
}

/**
 * Cut every stream into consecutive batches that each span less than a random one to five
 * seconds of event time, as a shipper that flushes every few seconds would.
 */
export function cutIntoBatches(sample: GenerationResult, random: () => number): StreamBatch[] {
  const batches: StreamBatch[] = [];
  for (const [stream, lines] of linesByStream(sample)) {
    let current: StreamBatch | undefined;
    let spanMs = 0;
    for (const line of lines) {
      const timeMs = Math.floor(line.tsUs / 1000);
      if (current === undefined || timeMs - current.fromMs >= spanMs) {
        spanMs = 1000 + Math.floor(random() * 4000);
        current = {
          stream,
          host: line.host,
          source: FILE_SOURCES[line.file],
          lines: [],
          fromMs: timeMs,
          toMs: timeMs,
        };
        batches.push(current);
      }
      current.lines.push(line.text);
      current.toMs = timeMs;
    }
  }
  return batches;
}

/**
 * Delivery order: every batch arrives up to `maxDelayMs` after its last event, never before
 * an earlier batch of its own stream. With batches that span less than five seconds and a
 * delay under four, no batch arrives more than nine seconds behind a newer one, which a
 * ten-second window absorbs.
 */
export function arrivalOrder(
  batches: readonly StreamBatch[],
  random: () => number,
  maxDelayMs: number,
): StreamBatch[] {
  const lastArrival = new Map<string, number>();
  const timed = batches.map((batch, index) => {
    const arrival = Math.max(
      lastArrival.get(batch.stream) ?? Number.NEGATIVE_INFINITY,
      batch.toMs + Math.floor(random() * maxDelayMs),
    );
    lastArrival.set(batch.stream, arrival);
    return { batch, arrival, index };
  });
  // Ties keep the cutting order, which keeps each stream's own order.
  timed.sort((a, b) => a.arrival - b.arrival || a.index - b.index);
  return timed.map((entry) => entry.batch);
}

export interface LiveRun {
  pipeline: Pipeline;
  sink: MemoryAlertSink;
  /** Deliver one batch; `ack=stored` unless told otherwise. */
  deliver(batch: StreamBatch, ack?: 'stored' | 'evaluated'): Promise<IngestSummary>;
  /** Events stored so far, when `keepEvents` was set. */
  events: NormalizedEvent[];
}

export interface LiveRunOptions extends PipelineOptions {
  /** Keep stored events in memory (to read them back after a restart). */
  keepEvents?: boolean;
  /** Share the alert sink and the stored events of an earlier run (a restart). */
  continueFrom?: LiveRun;
}

/**
 * A pipeline over the real parsers and rules with alerts in memory. Event ids are
 * `<stream>#<line number>`, the same in every run whatever the delivery order, so the
 * linked events of two runs can be compared directly.
 */
export function createLiveRun(options: LiveRunOptions = {}): LiveRun {
  const sink = options.continueFrom?.sink ?? createMemoryAlertSink();
  const events = options.continueFrom?.events ?? [];
  const counters = options.continueFrom
    ? (options.continueFrom as LiveRun & { counters: Map<string, number> }).counters
    : new Map<string, number>();
  let current = '';
  const eventStore: EventStore = {
    insertMany(batch) {
      if (options.keepEvents) events.push(...batch);
      return Promise.resolve();
    },
  };
  const pipeline = createPipeline({
    detector: createDetector({ rulesDir: RULES_DIR }),
    alertSink: sink,
    eventStore,
    newId: () => {
      const next = counters.get(current) ?? 0;
      counters.set(current, next + 1);
      return `${current}#${String(next).padStart(8, '0')}`;
    },
    ...options,
  });
  const run: LiveRun & { counters: Map<string, number> } = {
    pipeline,
    sink,
    events,
    counters,
    deliver(batch, ack = 'stored') {
      current = batch.stream;
      return pipeline.ingest(batch.lines, {
        source: batch.source,
        host: batch.host,
        timezone: 'UTC',
        receivedAt: RECEIVED_AT,
        stream: { kind: 'token', tokenId: null },
        ack,
      });
    },
  };
  return run;
}

/** What makes two alerts the same alert, without ids and wall-clock stamps. */
export interface AlertOutcome {
  ruleId: string;
  dedupKey: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  events: string[];
}

export function outcomes(sink: MemoryAlertSink): AlertOutcome[] {
  return sink
    .list()
    .map((alert: Alert) => ({
      ruleId: alert.ruleId,
      dedupKey: alert.dedupKey,
      firstSeen: alert.firstSeen,
      lastSeen: alert.lastSeen,
      count: alert.count,
      events: sink.eventIds(alert.id),
    }))
    .sort(
      (a, b) =>
        a.dedupKey.localeCompare(b.dedupKey, 'en') || a.firstSeen.localeCompare(b.firstSeen, 'en'),
    );
}

/**
 * The reference run (ARCHITECTURE §6.2): every event waits in the buffer, whatever order
 * the streams were delivered in, and is evaluated in order-key order at the end.
 */
export async function referenceRun(sample: GenerationResult): Promise<AlertOutcome[]> {
  const run = createLiveRun({
    reorder: {
      windowMs: Number.POSITIVE_INFINITY,
      idleMs: Number.POSITIVE_INFINITY,
      maxEvents: Number.POSITIVE_INFINITY,
    },
  });
  for (const [stream, lines] of linesByStream(sample)) {
    const first = lines[0];
    if (first === undefined) continue;
    await run.deliver({
      stream,
      host: first.host,
      source: FILE_SOURCES[first.file],
      lines: lines.map((line) => line.text),
      fromMs: 0,
      toMs: 0,
    });
  }
  await run.pipeline.drain();
  return outcomes(run.sink);
}

// ---- a restart without a database ------------------------------------------------------

/** Keeps the last checkpoint as JSON text, as the database would after a round trip. */
export function memoryCheckpoints(): CheckpointStore & { saved: string | null; saves: number } {
  const store = {
    saved: null as string | null,
    saves: 0,
    load(): Promise<Checkpoint | null> {
      return Promise.resolve(store.saved === null ? null : (JSON.parse(store.saved) as Checkpoint));
    },
    save(checkpoint: Checkpoint): Promise<void> {
      store.saved = JSON.stringify(checkpoint);
      store.saves += 1;
      return Promise.resolve();
    },
  };
  return store;
}

/** Reads back the events a `LiveRun` kept; ids must sort in the order they were stored. */
export function memoryReader(events: readonly NormalizedEvent[]): EventReader {
  return {
    byIds(ids) {
      const wanted = new Set(ids);
      return Promise.resolve(events.filter((event) => wanted.has(event.id)));
    },
    after(position, limit) {
      return Promise.resolve(
        events
          .filter((event) => position === null || event.id > position)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, limit),
      );
    },
    newestId() {
      let newest: string | null = null;
      for (const event of events) if (newest === null || event.id > newest) newest = event.id;
      return Promise.resolve(newest);
    },
  };
}
