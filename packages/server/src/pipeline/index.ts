/**
 * `createPipeline()` assembles the default implementation of each pipeline interface from
 * its owner's module (ARCHITECTURE §2.3). Tests and callers override any component.
 *
 * With a database pool the defaults are the PostgreSQL event store, alert sink and stream
 * registry, and the default detector gets its persisted rule flags (`rule_state`) before
 * the first batch. Without a pool, alerts stay in memory. The publisher defaults to a
 * no-op; the server passes its SSE hub (`src/realtime/`).
 *
 * Only the server passes `checkpoint: true`: its detector state is saved to the database
 * and restored at start (ARCHITECTURE §6.3). The command line and the tests keep their
 * state for the length of a run.
 */
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPgAlertSink } from '../db/alert-sink.js';
import { createCheckpointStore } from '../db/checkpoint.js';
import { createEventReader } from '../db/events-recovery.js';
import { createEventStore } from '../db/events-write.js';
import { createStreamRegistry } from '../db/streams.js';
import { createDetector } from '../detection/index.js';
import { createParserRegistry } from '../parsers/index.js';
import { repoRoot } from '../paths.js';
import { createMemoryAlertSink } from './memory-sink.js';
import { noopPublisher } from './noop-publisher.js';
import {
  createOrchestrator,
  type OrchestratorOptions,
  type Pipeline,
  type PipelineComponents,
} from './orchestrator.js';
import { createRuleCatalog, type RuleCatalog } from './rule-catalog.js';
import type { Detector } from './types.js';

export type {
  Pipeline,
  PipelineComponents,
  PipelineStats,
  RestoreSummary,
} from './orchestrator.js';
export type { RuleCatalog, RuleDetail } from './rule-catalog.js';
export * from './types.js';

export interface PipelineOptions extends Partial<PipelineComponents>, OrchestratorOptions {
  /** Pool for the default PostgreSQL event store and alert sink. */
  pool?: Pool;
  /** Rules folder for the default detector (default: `<repo>/rules`). */
  rulesDir?: string;
  /**
   * Persisted rule flags to load before the first batch. Defaults to a catalog over the
   * default detector when a pool is given; pass the server's catalog with its detector.
   */
  rules?: RuleCatalog;
  /**
   * Save the detector's state in the database and restore it at start. Needs a pool.
   * Default false: only one process, the server, owns the saved state.
   */
  checkpoint?: boolean;
}

export function createPipeline(options: PipelineOptions = {}): Pipeline {
  const { pool } = options;
  let detector: Detector;
  let rules = options.rules;
  if (options.detector) {
    detector = options.detector;
  } else {
    const engine = createDetector({ rulesDir: options.rulesDir ?? join(repoRoot, 'rules') });
    detector = engine;
    if (!rules && pool) rules = createRuleCatalog({ engine, pool });
  }
  const components: PipelineComponents = {
    parsers: options.parsers ?? createParserRegistry(),
    eventStore: options.eventStore ?? createEventStore(pool),
    detector,
    alertSink: options.alertSink ?? (pool ? createPgAlertSink(pool) : createMemoryAlertSink()),
    publisher: options.publisher ?? noopPublisher,
  };
  const streams = options.streams ?? (pool ? createStreamRegistry(pool) : undefined);
  if (streams) components.streams = streams;
  const checkpoints =
    options.checkpoints ?? (pool && options.checkpoint ? createCheckpointStore(pool) : undefined);
  if (checkpoints) components.checkpoints = checkpoints;
  const eventReader =
    options.eventReader ?? (pool && options.checkpoint ? createEventReader(pool) : undefined);
  if (eventReader) components.eventReader = eventReader;
  const catalog = rules;
  return createOrchestrator(components, {
    ...options,
    ...(catalog && { prepare: () => catalog.ready() }),
  });
}
