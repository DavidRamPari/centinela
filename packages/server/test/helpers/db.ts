/**
 * Throwaway database schema for integration tests. Every database test in every session
 * uses this helper:
 *
 *   const db = await createTestDatabase();
 *   afterAll(() => db.cleanup());
 *   await db.pool.query('SELECT count(*) FROM events');
 *
 * It creates a uniquely named schema, runs the migrations into it and returns a pool whose
 * connections use that schema as `search_path`. `cleanup()` closes the pool and drops the
 * schema. Requires PostgreSQL at DATABASE_URL (default: the development database; run
 * `docker compose up -d postgres` locally).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { DEV_DATABASE_URL } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';

export interface TestDatabase {
  pool: pg.Pool;
  schema: string;
  databaseUrl: string;
  cleanup(): Promise<void>;
}

export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEV_DATABASE_URL;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const databaseUrl = testDatabaseUrl();
  // Lower-case hex only, so the identifier never needs quoting rules beyond "...".
  const schema = `test_${randomBytes(8).toString('hex')}`;
  try {
    await runMigrations({ databaseUrl, schema });
  } catch (err) {
    throw new Error(
      `Could not prepare a test schema at ${new URL(databaseUrl).host}. Is PostgreSQL running? ` +
        `(docker compose up -d postgres) Cause: ${String(err)}`,
      { cause: err },
    );
  }
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    options: `-c search_path=${schema}`,
  });

  let cleaned = false;
  return {
    pool,
    schema,
    databaseUrl,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await pool.end();
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
