/** Server entry point: configuration, database pool, pipeline, HTTP server, signals. */
import { createApp } from './app.js';
import { isDevPassword } from './auth/password.js';
import { ConfigError, DEV_ADMIN_PASSWORD, loadConfig, type Config } from './config.js';
import { loadContentPack } from './content/pack.js';
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

// The configuration refuses the development hash itself; this also catches the development
// password hashed again with another salt (checking a password needs async argon2).
if (config.isProduction && (await isDevPassword(config.admin.passwordHash))) {
  console.error(
    'Invalid configuration:\n  - ADMIN_PASSWORD_HASH: must not hash the development password in production',
  );
  process.exit(1);
}
if (config.admin.usingDevPassword) {
  logger.warn(
    { username: config.admin.username, password: DEV_ADMIN_PASSWORD },
    'development sign-in in use; set ADMIN_PASSWORD_HASH (npm run hash-password) outside local development',
  );
}
const pool = createPool(config.databaseUrl, logger);
const detector = createDetector({ rulesDir: config.rulesDir });
const rules = createRuleCatalog({ engine: detector, pool });
const hub = createSseHub({ logger });
const pipeline = createPipeline({
  pool,
  detector,
  rules,
  publisher: hub,
  checkpoint: true,
  reorder: {
    windowMs: config.detection.reorderWindowMs,
    idleMs: config.detection.reorderIdleMs,
    maxEvents: config.detection.reorderMaxEvents,
  },
  maxFutureSkewMs: config.detection.maxFutureSkewMs,
  onBackgroundError: (err) => logger.error({ err }, 'evaluating buffered events failed'),
  // The alerts are held and written with the next write (S12-R08); dropped ones are lost.
  onAlertWriteError: ({ error, held, dropped }) =>
    logger.error({ err: error, held, dropped }, 'writing alerts failed'),
});
const app = createApp({ config, logger, pool, pipeline, rules, hub });

// Compile the rules and load their persisted flags now rather than on the first request.
rules.ready().then(
  () => logger.info({ rules: rules.list().length }, 'rules loaded'),
  (err: unknown) => logger.warn({ err }, 'rule flags not loaded yet; retrying on first use'),
);

// Correlation windows and buffered events of the last run (ARCHITECTURE §6.3). `ingest`
// waits for this, so a request that arrives first is not evaluated against empty state.
pipeline.restore().then(
  (summary) => logger.info(summary, 'detector state restored'),
  (err: unknown) => logger.warn({ err }, 'detector state not restored yet; retrying on first use'),
);
const checkpointTimer = setInterval(() => {
  pipeline.checkpoint().catch((err: unknown) => logger.error({ err }, 'checkpoint failed'));
}, config.detection.checkpointMs);
checkpointTimer.unref();

// Content-pack playbooks (optional): read once now, served from memory.
const content = loadContentPack(config.contentDir);
logger.info({ playbooks: content.size, skipped: content.errors.length }, 'content pack loaded');

const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    logger.fatal({ err }, 'could not start the HTTP server');
    process.exit(1);
  }
  logger.info({ port: config.port, env: config.nodeEnv, version }, 'centinela server listening');
});

const shutdown = createShutdown({
  server,
  pool,
  logger,
  // A clean stop saves the detector exactly as it is: nothing is evaluated early, and the
  // next start continues from here.
  beforeClose: async () => {
    clearInterval(checkpointTimer);
    pipeline.stop();
    if (await pipeline.checkpoint()) logger.info('detector state saved');
  },
});
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
