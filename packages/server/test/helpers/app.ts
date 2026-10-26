import { join } from 'node:path';
import type { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { createDetector } from '../../src/detection/index.js';
import { createLogger } from '../../src/logger.js';
import { createPipeline, type PipelineOptions } from '../../src/pipeline/index.js';
import { createRuleCatalog } from '../../src/pipeline/rule-catalog.js';
import { repoRoot } from '../../src/paths.js';
import { createSseHub, type SseHubOptions } from '../../src/realtime/hub.js';

export interface TestAppOptions {
  pool: Pool;
  env?: Record<string, string>;
  pipeline?: PipelineOptions;
  hub?: SseHubOptions;
}

/**
 * Express app with a silent logger and test configuration, wired like `src/index.ts`: one
 * detector shared by the pipeline and the rules API, and the SSE hub as the publisher.
 */
export function createTestApp(options: TestAppOptions) {
  const config: Config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...options.env });
  const detector = createDetector({ rulesDir: join(repoRoot, 'rules') });
  const rules = createRuleCatalog({ engine: detector, pool: options.pool });
  const hub = createSseHub(options.hub);
  const deps: AppDeps = {
    config,
    logger: createLogger(config),
    pool: options.pool,
    pipeline: createPipeline({
      pool: options.pool,
      detector,
      rules,
      publisher: hub,
      ...options.pipeline,
    }),
    rules,
    hub,
  };
  return { app: createApp(deps), deps };
}
