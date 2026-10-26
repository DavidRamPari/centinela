import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** `packages/server/migrations/`, the same relative location from `src/db` and `dist/db`. */
export const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

export const MIGRATIONS_TABLE = 'pgmigrations';

export interface MigrateOptions {
  databaseUrl: string;
  /** Target schema (created if missing). Defaults to `public`. Tests use a throwaway schema. */
  schema?: string;
  log?: (message: string) => void;
}

/** Apply pending migrations; returns the names of the migrations that ran (empty when up to date). */
export async function runMigrations(options: MigrateOptions): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const applied = await runner({
    databaseUrl: options.databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: MIGRATIONS_TABLE,
    ...(options.schema === undefined ? {} : { schema: options.schema, createSchema: true }),
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
    log,
    logger: { debug: () => undefined, info: log, warn: log, error: log },
  });
  return applied.map((migration) => migration.name);
}
