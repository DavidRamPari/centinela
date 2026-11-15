/**
 * Ingest orchestrator (ARCHITECTURE §2.3, §6.2, §6.3). Per batch of up to 1,000 lines:
 * parse → reject timestamps too far in the future → assign UUIDv7 ids and ingestedAt →
 * store → hand to the reorder buffer → evaluate what the buffer releases (detect → upsert
 * alerts → publish). Events wait in the buffer until the horizon passes them, so several
 * machines sending at once are evaluated in the order things happened.
 *
 * Every operation that touches the detector or the buffer (ingest calls, idle release,
 * drain, checkpoint, restore) runs on one queue, one at a time.
 *
 * The wall clock appears in three places and never in a rule: `ingestedAt` (record
 * keeping), the receive time that bounds timestamps from the future, and the idle timer
 * that decides when to stop waiting for older events.
 */
import { performance } from 'node:perf_hooks';
import type { NormalizedEvent } from '@centinela/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ReorderBuffer, type Buffered } from './reorder.js';
import type {
  AlertCandidate,
  AlertPublisher,
  AlertSink,
  CheckpointStore,
  Detector,
  EventReader,
  EventStore,
  IngestContext,
  IngestSummary,
  ParserRegistry,
  StreamRegistry,
} from './types.js';

export const BATCH_SIZE = 1000;
export const MAX_REJECTION_SAMPLES = 20;

/** Defaults of `REORDER_WINDOW_SECONDS`, `REORDER_IDLE_MS` and `REORDER_MAX_EVENTS`. */
export const DEFAULT_REORDER_WINDOW_MS = 10_000;
export const DEFAULT_REORDER_IDLE_MS = 5_000;
export const DEFAULT_REORDER_MAX_EVENTS = 100_000;
/** Default of `MAX_FUTURE_SKEW_SECONDS`: the day RFC 3164 timestamps already tolerate. */
export const DEFAULT_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/** Events read per query when the detector catches up after a restart. */
export const RECOVERY_PAGE_SIZE = 1000;

export const FUTURE_TIMESTAMP_REASON = 'timestamp too far in the future';
export const INVALID_TIMESTAMP_REASON = 'invalid timestamp';

/** Version of the saved state; a checkpoint with another version is not restored. */
export const SNAPSHOT_VERSION = 1;

const orderKeySchema = z.object({
  time: z.number(),
  host: z.string(),
  source: z.string(),
  id: z.string(),
});

/** What `checkpoint()` saves: the detector's own snapshot and the buffer's. */
export const pipelineSnapshotSchema = z.object({
  engine: z.unknown(),
  buffer: z.object({
    newest: z.number().nullable(),
    lastReleased: orderKeySchema.nullable(),
    events: z.array(z.object({ id: z.string(), time: z.number() })),
  }),
});
export type PipelineSnapshot = z.infer<typeof pipelineSnapshotSchema>;

export interface PipelineComponents {
  parsers: ParserRegistry;
  eventStore: EventStore;
  detector: Detector;
  alertSink: AlertSink;
  publisher: AlertPublisher;
  /** Delivery streams: provenance of every event and counters per stream. */
  streams?: StreamRegistry;
  /** Where the detector's state is saved; only the server passes one. */
  checkpoints?: CheckpointStore;
  /** Reads stored events back when restoring a checkpoint. */
  eventReader?: EventReader;
}

export interface RestoreSummary {
  /** A saved state was found and loaded. */
  restored: boolean;
  /** Correlation rules whose windows were restored, and dropped because the rule changed. */
  rules: { restored: number; dropped: number };
  /** Events put back into the reorder buffer. */
  buffered: number;
  /** Events stored after the checkpoint and handed to the buffer again. */
  replayed: number;
  /** Why a saved state was ignored, if it was. */
  ignored?: string;
}

export interface PipelineStats {
  /** Events waiting in the reorder buffer. */
  buffered: number;
  evaluated: number;
  /** Events evaluated out of order because they arrived behind the last released one. */
  late: number;
  /** Events released before the horizon because the buffer was full. */
  early: number;
}

export interface Pipeline {
  readonly components: PipelineComponents;
  /**
   * Run lines through the pipeline. Blank lines are skipped and not counted; a trailing
   * `\r` is removed. Calls are serialized, so concurrent requests never interleave batches
   * inside the detector.
   */
  ingest(
    lines: Iterable<string> | AsyncIterable<string>,
    ctx: IngestContext,
  ): Promise<IngestSummary>;
  /** Evaluate everything still waiting in the reorder buffer (the end of a bounded input). */
  drain(): Promise<void>;
  /**
   * Save the detector's state. Resolves to false when there is no checkpoint store or
   * nothing changed since the last save.
   */
  checkpoint(): Promise<boolean>;
  /**
   * Load the saved state and evaluate what was stored after it. Runs once; `ingest` waits
   * for it, so no event is evaluated against a state that is still loading.
   */
  restore(): Promise<RestoreSummary>;
  /** Cancel the idle timer (shutdown and tests). Buffered events stay buffered. */
  stop(): void;
  stats(): PipelineStats;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: Timers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    // A waiting buffer must not keep a command-line run alive.
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface OrchestratorOptions {
  batchSize?: number;
  /** Wall clock for `ingestedAt` (record keeping only; detection uses event time). */
  now?: () => Date;
  newId?: () => string;
  /**
   * Awaited before every run, before any line is read (for example, loading persisted rule
   * flags into the detector). It must be cheap after its first success.
   */
  prepare?: () => Promise<void>;
  reorder?: {
    /** Default 10 s; 0 evaluates on arrival; `Infinity` holds everything until `drain()`. */
    windowMs?: number;
    /** Default 5 s; `Infinity` never releases on idleness. */
    idleMs?: number;
    /** Default 100,000. */
    maxEvents?: number;
  };
  /** Events dated further ahead of the receive time than this are rejected (default 24 h). */
  maxFutureSkewMs?: number;
  timers?: Timers;
  /** Called when work that no request is waiting for fails (the idle release). */
  onBackgroundError?: (err: unknown) => void;
}

interface PendingLine {
  lineNumber: number;
  text: string;
}

/** The counters evaluation adds to; an `IngestSummary` is one. */
interface AlertCounts {
  alertsCreated: number;
  alertsUpdated: number;
}

export function createOrchestrator(
  components: PipelineComponents,
  options: OrchestratorOptions = {},
): Pipeline {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => uuidv7());
  const timers = options.timers ?? defaultTimers;
  const idleMs = options.reorder?.idleMs ?? DEFAULT_REORDER_IDLE_MS;
  const maxFutureSkewMs = options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  const { parsers, eventStore, detector, alertSink, publisher, streams, checkpoints, eventReader } =
    components;

  const buffer = new ReorderBuffer({
    windowMs: options.reorder?.windowMs ?? DEFAULT_REORDER_WINDOW_MS,
    maxEvents: options.reorder?.maxEvents ?? DEFAULT_REORDER_MAX_EVENTS,
  });
  const totals = { evaluated: 0, late: 0, early: 0 };
  /** Sequence number of the current ingest call (0: events read back at start). */
  let callNumber = 0;
  /** Id of the last event handed to the buffer: the checkpoint's position. */
  let position: string | null = null;
  /** Something changed since the last checkpoint. */
  let dirty = false;
  /** Newest detection time evaluated since the last detector flush. */
  let evaluatedNewest: number | undefined;
  let idleTimer: unknown;
  let stopped = false;

  async function sinkAndPublish(candidates: AlertCandidate[], counts: AlertCounts) {
    if (candidates.length === 0) return;
    const { created, updated } = await alertSink.upsert(candidates);
    counts.alertsCreated += created.length;
    counts.alertsUpdated += updated.length;
    for (const alert of created) publisher.publish({ type: 'alert.created', alert });
    for (const alert of updated) publisher.publish({ type: 'alert.updated', alert });
  }

  /** Detect on events that left the buffer, in the order given, and write their alerts. */
  async function evaluate(items: readonly Buffered[], counts: AlertCounts): Promise<void> {
    if (items.length === 0) return;
    const candidates: AlertCandidate[] = [];
    for (const item of items) {
      for (const candidate of detector.process(item.event, item.time)) candidates.push(candidate);
      if (evaluatedNewest === undefined || item.time > evaluatedNewest) evaluatedNewest = item.time;
    }
    totals.evaluated += items.length;
    dirty = true;
    await sinkAndPublish(candidates, counts);
  }

  /** Let the detector drop expired state at the newest time evaluated since the last flush. */
  async function flushDetector(counts: AlertCounts): Promise<void> {
    if (evaluatedNewest === undefined) return;
    const at = new Date(evaluatedNewest);
    evaluatedNewest = undefined;
    await sinkAndPublish(detector.flush(at), counts);
  }

  /** Hand stored events to the buffer and evaluate what it gives back: late ones first. */
  async function admit(items: readonly Buffered[], counts: AlertCounts): Promise<Buffered[]> {
    for (const item of items) {
      if (position === null || item.event.id > position) position = item.event.id;
    }
    const { late, released, early } = buffer.push(items);
    totals.late += late.length;
    totals.early += early;
    dirty = true;
    await evaluate(late, counts);
    await evaluate(released, counts);
    return late;
  }

  function reject(summary: IngestSummary, lineNumber: number, reason: string) {
    summary.rejected += 1;
    if (summary.rejections.length < MAX_REJECTION_SAMPLES) {
      summary.rejections.push({ line: lineNumber, reason });
    }
  }

  /** Counters of one ingest call beyond what the summary holds. */
  interface CallState {
    call: number;
    streamId: string | null;
    /** Newest detection time accepted in the call. */
    newest: number | undefined;
    /** Newest event time accepted in the call (for the stream's last signal). */
    newestEventTime: number | undefined;
  }

  async function processBatch(
    batch: PendingLine[],
    ctx: IngestContext,
    summary: IngestSummary,
    state: CallState,
  ): Promise<void> {
    const parser = parsers.get(ctx.source);
    const ingestedAt = now().toISOString();
    const receivedAt = ctx.receivedAt.getTime();
    const items: Buffered[] = [];
    for (const { lineNumber, text } of batch) {
      if (!parser) {
        reject(summary, lineNumber, 'unknown source');
        continue;
      }
      let result;
      try {
        result = parser.parse(text, ctx);
      } catch {
        reject(summary, lineNumber, 'parser error');
        continue;
      }
      if (!result.ok) {
        reject(summary, lineNumber, result.reason);
        continue;
      }
      const eventTime = Date.parse(result.event.ts);
      if (Number.isNaN(eventTime)) {
        reject(summary, lineNumber, INVALID_TIMESTAMP_REASON);
        continue;
      }
      if (eventTime - receivedAt > maxFutureSkewMs) {
        reject(summary, lineNumber, FUTURE_TIMESTAMP_REASON);
        continue;
      }
      const event: NormalizedEvent = { ...result.event, id: newId(), ingestedAt };
      // An event cannot have happened after it was received: detection never runs on a
      // time ahead of the server's clock, whatever the log line claims.
      items.push({ event, time: Math.min(eventTime, receivedAt), call: state.call });
      if (state.newestEventTime === undefined || eventTime > state.newestEventTime) {
        state.newestEventTime = eventTime;
      }
    }
    if (items.length === 0) return;

    // Array.prototype.sort is stable, so equal timestamps keep their line order.
    const stored = [...items].sort((a, b) => a.time - b.time).map((item) => item.event);
    await eventStore.insertMany(stored, { streamId: state.streamId });
    summary.accepted += items.length;
    for (const item of items) {
      if (state.newest === undefined || item.time > state.newest) state.newest = item.time;
    }

    const late = await admit(items, summary);
    summary.late += late.length;
  }

  async function run(
    lines: Iterable<string> | AsyncIterable<string>,
    ctx: IngestContext,
  ): Promise<IngestSummary> {
    await options.prepare?.();
    await restoreOnce();
    const started = performance.now();
    const summary: IngestSummary = {
      accepted: 0,
      rejected: 0,
      rejections: [],
      alertsCreated: 0,
      alertsUpdated: 0,
      durationMs: 0,
      pending: 0,
      late: 0,
    };
    callNumber += 1;
    const state: CallState = {
      call: callNumber,
      streamId: null,
      newest: undefined,
      newestEventTime: undefined,
    };
    if (streams) {
      state.streamId = await streams.resolve({
        kind: ctx.stream?.kind ?? 'cli',
        tokenId: ctx.stream?.tokenId ?? null,
        source: ctx.source,
        host: ctx.host,
      });
    }

    let batch: PendingLine[] = [];
    let lineNumber = 0;
    const processPending = async () => {
      const current = batch;
      batch = [];
      await processBatch(current, ctx, summary, state);
    };
    for await (const raw of lines) {
      lineNumber += 1;
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (text.trim() === '') continue;
      batch.push({ lineNumber, text });
      if (batch.length >= batchSize) await processPending();
    }
    if (batch.length > 0) await processPending();

    if ((ctx.ack ?? 'evaluated') === 'evaluated' && state.newest !== undefined) {
      // The caller wants final counts: evaluate everything up to its newest event now.
      await evaluate(buffer.releaseThrough(state.newest), summary);
    } else {
      summary.pending = buffer.countOfCall(state.call);
    }
    await flushDetector(summary);

    if (streams && state.streamId !== null) {
      await streams.record(state.streamId, {
        accepted: summary.accepted,
        rejected: summary.rejected,
        late: summary.late,
        lastEventTs: state.newestEventTime === undefined ? null : new Date(state.newestEventTime),
        at: ctx.receivedAt,
      });
    }
    summary.durationMs = Math.round((performance.now() - started) * 100) / 100;
    return summary;
  }

  // ---- idle release ------------------------------------------------------------------

  function armIdleTimer(): void {
    if (idleTimer !== undefined) {
      timers.clear(idleTimer);
      idleTimer = undefined;
    }
    if (stopped || buffer.size === 0 || !Number.isFinite(idleMs)) return;
    idleTimer = timers.set(() => {
      idleTimer = undefined;
      enqueue(async () => {
        const counts = { alertsCreated: 0, alertsUpdated: 0 };
        await evaluate(buffer.releaseAll(), counts);
        await flushDetector(counts);
      }).catch((err: unknown) => options.onBackgroundError?.(err));
    }, idleMs);
  }

  // ---- checkpoint and restore ----------------------------------------------------------

  async function saveCheckpoint(): Promise<boolean> {
    if (!checkpoints || !dirty) return false;
    const snapshot: PipelineSnapshot = {
      engine: detector.snapshot?.() ?? null,
      buffer: buffer.snapshot(),
    };
    await checkpoints.save({ position, version: SNAPSHOT_VERSION, state: snapshot });
    dirty = false;
    return true;
  }

  let restoring: Promise<RestoreSummary> | undefined;
  /** The detector's state before anything was restored into it. */
  let pristine: unknown;

  /**
   * Forget what a restore that failed half way left behind. The next attempt reads the
   * same checkpoint and the same events again; on top of what this one already put into
   * the buffer and the detector, they would be evaluated twice.
   */
  function forgetRestore(): void {
    buffer.restore({ newest: null, lastReleased: null, items: [] });
    evaluatedNewest = undefined;
    if (pristine !== undefined && pristine !== null) detector.restore?.(pristine);
  }

  async function loadCheckpoint(): Promise<RestoreSummary> {
    const summary: RestoreSummary = {
      restored: false,
      rules: { restored: 0, dropped: 0 },
      buffered: 0,
      replayed: 0,
    };
    if (!checkpoints || !eventReader) return summary;
    // Stored events are evaluated below. Whoever asked for the restore (a checkpoint on
    // the timer can be the first), the detector needs its persisted rule flags by then.
    await options.prepare?.();
    pristine ??= detector.snapshot?.();
    const saved = await checkpoints.load();
    if (saved === null) {
      // First start on this database: everything already stored was evaluated by whoever
      // stored it. Mark the place, so a crash before the first timed checkpoint only
      // repeats what arrives from now on.
      position = await eventReader.newestId();
      dirty = true;
      await saveCheckpoint();
      return summary;
    }
    position = saved.position;
    const parsed =
      saved.version === SNAPSHOT_VERSION ? pipelineSnapshotSchema.safeParse(saved.state) : null;
    if (parsed === null) {
      summary.ignored = `saved state has version ${saved.version}, this server reads ${SNAPSHOT_VERSION}`;
    } else if (!parsed.success) {
      summary.ignored = 'saved state is malformed';
    } else {
      const snapshot = parsed.data;
      // Reading the buffered events back is the database's work. A failure here says
      // nothing about the saved state, so it is not caught: the restore fails as a whole,
      // the checkpoint stays as it is and the next call tries again.
      const times = new Map(snapshot.buffer.events.map((e) => [e.id, e.time]));
      const items: Buffered[] = [];
      const ids = [...times.keys()];
      for (let start = 0; start < ids.length; start += RECOVERY_PAGE_SIZE) {
        const events = await eventReader.byIds(ids.slice(start, start + RECOVERY_PAGE_SIZE));
        for (const event of events) {
          const time = times.get(event.id);
          if (time !== undefined) items.push({ event, time, call: 0 });
        }
      }
      let usable = true;
      if (snapshot.engine !== null && detector.restore) {
        try {
          // Throws on a snapshot it cannot trust and then leaves the detector as it was.
          summary.rules = detector.restore(snapshot.engine);
        } catch {
          usable = false;
          summary.ignored = 'saved state is malformed';
        }
      }
      if (usable) {
        buffer.restore({
          newest: snapshot.buffer.newest,
          lastReleased: snapshot.buffer.lastReleased,
          items,
        });
        summary.restored = true;
        summary.buffered = items.length;
      }
    }

    // What was stored after the checkpoint: evaluated after it and lost with the process,
    // or stored and never evaluated. Either way it goes through the buffer again.
    const counts = { alertsCreated: 0, alertsUpdated: 0 };
    for (;;) {
      const page = await eventReader.after(position, RECOVERY_PAGE_SIZE);
      if (page.length === 0) break;
      const items: Buffered[] = [];
      for (const event of page) {
        const eventTime = Date.parse(event.ts);
        const received = Date.parse(event.ingestedAt);
        if (Number.isNaN(eventTime)) continue;
        const time = Number.isNaN(received) ? eventTime : Math.min(eventTime, received);
        items.push({ event, time, call: 0 });
      }
      const last = page[page.length - 1];
      await admit(items, counts);
      // `admit` moves the position to the newest id it saw; an unreadable page still advances.
      if (last !== undefined && (position === null || last.id > position)) position = last.id;
      summary.replayed += items.length;
    }
    await flushDetector(counts);
    if (summary.replayed > 0 || summary.ignored !== undefined) {
      dirty = true;
      await saveCheckpoint();
    } else {
      dirty = false;
    }
    armIdleTimer();
    return summary;
  }

  /** Runs inside a queued task. */
  function restoreOnce(): Promise<RestoreSummary> {
    restoring ??= loadCheckpoint().catch((err: unknown) => {
      // Let the next call try again (the database may have been down), from a clean start.
      restoring = undefined;
      forgetRestore();
      throw err;
    });
    return restoring;
  }

  // ---- the queue -----------------------------------------------------------------------

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    components,
    ingest(lines, ctx) {
      return enqueue(async () => {
        try {
          return await run(lines, ctx);
        } finally {
          armIdleTimer();
        }
      });
    },
    drain() {
      return enqueue(async () => {
        const counts = { alertsCreated: 0, alertsUpdated: 0 };
        await evaluate(buffer.releaseAll(), counts);
        await flushDetector(counts);
        armIdleTimer();
      });
    },
    checkpoint() {
      return enqueue(async () => {
        await restoreOnce();
        return saveCheckpoint();
      });
    },
    restore() {
      return enqueue(async () => {
        await options.prepare?.();
        return restoreOnce();
      });
    },
    stop() {
      stopped = true;
      if (idleTimer !== undefined) {
        timers.clear(idleTimer);
        idleTimer = undefined;
      }
    },
    stats() {
      return { buffered: buffer.size, ...totals };
    },
  };
}
