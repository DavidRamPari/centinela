/** `npm run db:migrate`: apply pending migrations to DATABASE_URL. */
import { ConfigError, loadConfig } from '../../config.js';
import { loadDotEnv } from '../../env.js';
import { runMigrations } from '../migrate.js';

function redactUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password !== '') url.password = '***';
  return url.toString();
}

try {
  loadDotEnv();
  const config = loadConfig();
  const applied = await runMigrations({ databaseUrl: config.databaseUrl });
  if (applied.length === 0) {
    console.log(`Database is up to date (${redactUrl(config.databaseUrl)}).`);
  } else {
    console.log(`Applied ${applied.length} migration(s) to ${redactUrl(config.databaseUrl)}:`);
    for (const name of applied) console.log(`  - ${name}`);
  }
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `Migration failed: ${String(err)}`);
  process.exitCode = 1;
}
