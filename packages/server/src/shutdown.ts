import type { Server } from 'node:http';
import type { Logger } from './logger.js';

export interface ShutdownDeps {
  server: Server;
  /** Anything with `end()`, typically the pg pool. */
  pool: { end(): Promise<void> };
  logger: Logger;
  /** After this long, open connections (SSE streams, keep-alive) are closed forcibly. */
  timeoutMs?: number;
  /**
   * Runs after the last request finished and before the pool closes: the place to save
   * state that needs the database (the detector checkpoint). A failure is logged and does
   * not stop the shutdown.
   */
  beforeClose?: () => Promise<void>;
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish (up to
 * `timeoutMs`), run `beforeClose`, then close the database pool. Calling it twice is
 * harmless.
 */
export function createShutdown({
  server,
  pool,
  logger,
  timeoutMs = 10_000,
  beforeClose,
}: ShutdownDeps) {
  let pending: Promise<void> | undefined;
  return function shutdown(reason: string): Promise<void> {
    pending ??= (async () => {
      logger.info({ reason }, 'shutting down');
      const force = setTimeout(() => server.closeAllConnections(), timeoutMs);
      force.unref();
      const closed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server.closeIdleConnections();
      try {
        await closed;
      } finally {
        clearTimeout(force);
        try {
          await beforeClose?.();
        } catch (err) {
          logger.error({ err }, 'could not save state before closing');
        }
        await pool.end();
      }
      logger.info('shutdown complete');
    })();
    return pending;
  };
}
