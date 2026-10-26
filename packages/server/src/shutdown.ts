import type { Server } from 'node:http';
import type { Logger } from './logger.js';

export interface ShutdownDeps {
  server: Server;
  /** Anything with `end()`, typically the pg pool. */
  pool: { end(): Promise<void> };
  logger: Logger;
  /** After this long, open connections (SSE streams, keep-alive) are closed forcibly. */
  timeoutMs?: number;
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish (up to
 * `timeoutMs`), then close the database pool. Calling it twice is harmless.
 */
export function createShutdown({ server, pool, logger, timeoutMs = 10_000 }: ShutdownDeps) {
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
        await pool.end();
      }
      logger.info('shutdown complete');
    })();
    return pending;
  };
}
