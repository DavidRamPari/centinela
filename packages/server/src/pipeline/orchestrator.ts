/**
 * Ingest orchestrator (ARCHITECTURE §2.3). Per batch of up to 1,000 lines:
 * parse → assign UUIDv7 ids and ingestedAt → stable sort by event time → store →
 * detect → upsert alerts → publish. At the end of the input: flush the detector at the
 * newest event time seen.
 */
import { performance } from 'node:perf_hooks';
import type { NormalizedEvent } from '@centinela/shared';
import { v7 as uuidv7 } from 'uuid';
import type {
  AlertCandidate,
  AlertPublisher,
  AlertSink,
  Detector,
  EventStore,
  IngestContext,
  IngestSummary,
  ParserRegistry,
} from './types.js';

export const BATCH_SIZE = 1000;
export const MAX_REJECTION_SAMPLES = 20;

export interface PipelineComponents {
  parsers: ParserRegistry;
  eventStore: EventStore;
  detector: Detector;
  alertSink: AlertSink;
  publisher: AlertPublisher;
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
}

export interface OrchestratorOptions {
  batchSize?: number;
  /** Wall clock for `ingestedAt` (record keeping only; detection uses event time). */
  now?: () => Date;
  newId?: () => string;
}

interface PendingLine {
  lineNumber: number;
  text: string;
}

export function createOrchestrator(
  components: PipelineComponents,
  options: OrchestratorOptions = {},
): Pipeline {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => uuidv7());
  const { parsers, eventStore, detector, alertSink, publisher } = components;

  async function sinkAndPublish(candidates: AlertCandidate[], summary: IngestSummary) {
    if (candidates.length === 0) return;
    const { created, updated } = await alertSink.upsert(candidates);
    summary.alertsCreated += created.length;
    summary.alertsUpdated += updated.length;
    for (const alert of created) publisher.publish({ type: 'alert.created', alert });
    for (const alert of updated) publisher.publish({ type: 'alert.updated', alert });
  }

  function reject(summary: IngestSummary, lineNumber: number, reason: string) {
    summary.rejected += 1;
    if (summary.rejections.length < MAX_REJECTION_SAMPLES) {
      summary.rejections.push({ line: lineNumber, reason });
    }
  }

  /** Returns the newest event time in the batch (epoch ms), if any event was accepted. */
  async function processBatch(
    batch: PendingLine[],
    ctx: IngestContext,
    summary: IngestSummary,
  ): Promise<number | undefined> {
    const parser = parsers.get(ctx.source);
    const ingestedAt = now().toISOString();
    const parsed: Array<{ event: NormalizedEvent; time: number }> = [];
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
      const event: NormalizedEvent = { ...result.event, id: newId(), ingestedAt };
      parsed.push({ event, time: Date.parse(event.ts) });
    }
    if (parsed.length === 0) return undefined;

    // Array.prototype.sort is stable, so equal timestamps keep their line order.
    parsed.sort((a, b) => a.time - b.time);
    const events = parsed.map((p) => p.event);
    await eventStore.insertMany(events);
    summary.accepted += events.length;

    const candidates = events.flatMap((event) => detector.process(event));
    await sinkAndPublish(candidates, summary);
    return parsed[parsed.length - 1]?.time;
  }

  async function run(
    lines: Iterable<string> | AsyncIterable<string>,
    ctx: IngestContext,
  ): Promise<IngestSummary> {
    const started = performance.now();
    const summary: IngestSummary = {
      accepted: 0,
      rejected: 0,
      rejections: [],
      alertsCreated: 0,
      alertsUpdated: 0,
      durationMs: 0,
    };
    let watermark: number | undefined;
    let batch: PendingLine[] = [];
    let lineNumber = 0;

    const drain = async () => {
      const newest = await processBatch(batch, ctx, summary);
      if (newest !== undefined) watermark = Math.max(watermark ?? newest, newest);
      batch = [];
    };

    for await (const raw of lines) {
      lineNumber += 1;
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (text.trim() === '') continue;
      batch.push({ lineNumber, text });
      if (batch.length >= batchSize) await drain();
    }
    if (batch.length > 0) await drain();
    if (watermark !== undefined) {
      await sinkAndPublish(detector.flush(new Date(watermark)), summary);
    }

    summary.durationMs = Math.round((performance.now() - started) * 100) / 100;
    return summary;
  }

  let queue: Promise<unknown> = Promise.resolve();
  return {
    components,
    ingest(lines, ctx) {
      const result = queue.then(() => run(lines, ctx));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
