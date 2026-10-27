import { join } from 'node:path';
import { SESSION_COOKIE } from '@centinela/shared';
import express, { type Express } from 'express';
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
import { TEST_PASSWORD_HASH, TEST_USERNAME, createSignedInSession, type SignedIn } from './auth.js';

export interface TestAppOptions {
  pool: Pool;
  env?: Record<string, string>;
  pipeline?: PipelineOptions;
  hub?: SseHubOptions;
  /**
   * Default true: every request is sent as the signed-in admin (a real session row, its
   * cookies and the CSRF header), unless the test sets its own `Cookie` header. Pass false
   * to send requests exactly as written, e.g. to test authentication itself.
   */
  signedIn?: boolean;
}

/**
 * Express app with a silent logger and test configuration, wired like `src/index.ts`: one
 * detector shared by the pipeline and the rules API, and the SSE hub as the publisher.
 */
export function createTestApp(options: TestAppOptions) {
  const config: Config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ADMIN_USERNAME: TEST_USERNAME,
    ADMIN_PASSWORD_HASH: TEST_PASSWORD_HASH,
    ...options.env,
  });
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
  const app = createApp(deps);
  return { app: options.signedIn === false ? app : signedInApp(app, config, options.pool), deps };
}

/** Wraps `app` so requests without a session cookie carry the test admin's session. */
function signedInApp(app: Express, config: Config, pool: Pool): Express {
  let session: Promise<SignedIn> | undefined;
  const outer = express();
  outer.disable('x-powered-by');
  outer.use((req, _res, next) => {
    if (req.headers.cookie?.includes(`${SESSION_COOKIE}=`)) {
      next();
      return;
    }
    session ??= createSignedInSession(config, pool);
    session.then(
      ({ cookie, csrf }) => {
        req.headers.cookie = req.headers.cookie ? `${req.headers.cookie}; ${cookie}` : cookie;
        req.headers['x-csrf-token'] ??= csrf;
        next();
      },
      (err: unknown) => next(err),
    );
  });
  outer.use(app);
  return outer;
}
