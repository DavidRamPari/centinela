import pg from 'pg';
import type { Logger } from '../logger.js';

export type { Pool } from 'pg';

export interface PoolOptions {
  max?: number;
  connectionTimeoutMillis?: number;
}

/** Connection pool. Idle-client errors are logged instead of crashing the process. */
export function createPool(
  databaseUrl: string,
  logger: Logger,
  options: PoolOptions = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'centinela',
  });
  pool.on('error', (err) => {
    logger.error({ err }, 'idle PostgreSQL client error');
  });
  return pool;
}

/** `SELECT 1` with a deadline; resolves to false instead of throwing. */
export async function checkDatabase(pool: pg.Pool, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const query = pool.query('SELECT 1').then(
    () => true,
    () => false,
  );
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([query, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
