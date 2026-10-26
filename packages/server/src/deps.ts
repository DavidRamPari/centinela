import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Pipeline } from './pipeline/orchestrator.js';

/** Everything the HTTP layer needs; built once in `index.ts`, replaced by fakes in tests. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  pool: Pool;
  pipeline: Pipeline;
}
