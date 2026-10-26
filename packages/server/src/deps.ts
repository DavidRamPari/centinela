import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Pipeline } from './pipeline/orchestrator.js';
import type { RuleCatalog } from './pipeline/rule-catalog.js';
import type { SseHub } from './realtime/hub.js';

/** Everything the HTTP layer needs; built once in `index.ts`, replaced by fakes in tests. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  pool: Pool;
  pipeline: Pipeline;
  /** Loaded rules and their persisted enable/disable flags (the pipeline's detector). */
  rules: RuleCatalog;
  /** Live alert stream; also the pipeline's publisher. */
  hub: SseHub;
}
