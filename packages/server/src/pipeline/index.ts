/**
 * `createPipeline()` assembles the default implementation of each pipeline interface from
 * its owner's module (ARCHITECTURE §2.3). Tests and callers override any component.
 * S4 switches the defaults to the PostgreSQL sink and the SSE publisher.
 */
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createEventStore } from '../db/events-write.js';
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

export type { Pipeline, PipelineComponents } from './orchestrator.js';
export * from './types.js';

export interface PipelineOptions extends Partial<PipelineComponents>, OrchestratorOptions {
  /** Pool for the default PostgreSQL event store. */
  pool?: Pool;
  /** Rules folder for the default detector (default: `<repo>/rules`). */
  rulesDir?: string;
}

export function createPipeline(options: PipelineOptions = {}): Pipeline {
  const components: PipelineComponents = {
    parsers: options.parsers ?? createParserRegistry(),
    eventStore: options.eventStore ?? createEventStore(options.pool),
    detector:
      options.detector ?? createDetector({ rulesDir: options.rulesDir ?? join(repoRoot, 'rules') }),
    alertSink: options.alertSink ?? createMemoryAlertSink(),
    publisher: options.publisher ?? noopPublisher,
  };
  return createOrchestrator(components, options);
}
