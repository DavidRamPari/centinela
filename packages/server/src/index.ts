/** Server entry point: configuration, database pool, pipeline, HTTP server, signals. */
import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createPool } from './db/pool.js';
import { createDetector } from './detection/index.js';
import { loadDotEnv } from './env.js';
import { createLogger } from './logger.js';
import { createPipeline } from './pipeline/index.js';
import { createRuleCatalog } from './pipeline/rule-catalog.js';
import { createSseHub } from './realtime/hub.js';
import { createShutdown } from './shutdown.js';
import { version } from './version.js';

function readConfig(): Config {
  try {
    loadDotEnv();
    return loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
}

const config = readConfig();
const logger = createLogger(config);
const pool = createPool(config.databaseUrl, logger);
const detector = createDetector({ rulesDir: config.rulesDir });
const rules = createRuleCatalog({ engine: detector, pool });
const hub = createSseHub({ logger });
const pipeline = createPipeline({ pool, detector, rules, publisher: hub });
const app = createApp({ config, logger, pool, pipeline, rules, hub });

// Compile the rules and load their persisted flags now rather than on the first request.
rules.ready().then(
  () => logger.info({ rules: rules.list().length }, 'rules loaded'),
  (err: unknown) => logger.warn({ err }, 'rule flags not loaded yet; retrying on first use'),
);

const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    logger.fatal({ err }, 'could not start the HTTP server');
    process.exit(1);
  }
  logger.info({ port: config.port, env: config.nodeEnv, version }, 'centinela server listening');
});

const shutdown = createShutdown({ server, pool, logger });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Live streams never end on their own; close them so the server can drain.
    hub.close();
    shutdown(signal).then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
