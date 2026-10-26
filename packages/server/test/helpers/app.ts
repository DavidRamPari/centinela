import type { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { createLogger } from '../../src/logger.js';
import { createPipeline, type PipelineOptions } from '../../src/pipeline/index.js';

export interface TestAppOptions {
  pool: Pool;
  env?: Record<string, string>;
  pipeline?: PipelineOptions;
}

/** Express app with a silent logger and test configuration. */
export function createTestApp(options: TestAppOptions) {
  const config: Config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...options.env });
  const deps: AppDeps = {
    config,
    logger: createLogger(config),
    pool: options.pool,
    pipeline: createPipeline({ pool: options.pool, ...options.pipeline }),
  };
  return { app: createApp(deps), deps };
}
