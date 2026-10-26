/** Server entry point: configuration, database pool, pipeline, HTTP server, signals. */
import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createPool } from './db/pool.js';
import { loadDotEnv } from './env.js';
import { createLogger } from './logger.js';
import { createPipeline } from './pipeline/index.js';
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
const pipeline = createPipeline({ pool, rulesDir: config.rulesDir });
const app = createApp({ config, logger, pool, pipeline });

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
    shutdown(signal).then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
