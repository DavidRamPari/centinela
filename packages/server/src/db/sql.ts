/**
 * Small helpers for hand-written, parameterized SQL (D-002). Values always travel as
 * parameters; only fixed SQL fragments written in this folder are concatenated.
 */
import type { Pool, PoolClient } from 'pg';

/** Collects positional parameters: `params.add(value)` returns its placeholder (`$n`). */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** `WHERE a AND b ...`, or an empty string without conditions. */
export function whereClause(conditions: readonly string[]): string {
  return conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
}

/** Run `fn` inside a transaction on one client; roll back and rethrow on error. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** `count(*)` arrives as a string (bigint); counts here always fit in a JS number. */
export function toCount(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}
