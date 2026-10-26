/**
 * `npm run demo [-- --reset]`
 *
 * Generates the demo data set with loggen (fixed seed, three days of "Andes Retail"
 * traffic ending at the current hour, so the dashboard's default time ranges show it),
 * applies the migrations to DATABASE_URL, ingests every file through the real pipeline
 * (parsers, event store, detection with the persisted rule flags, PostgreSQL alert sink)
 * and prints a detection summary against the generator's ground truth.
 *
 * It refuses to add a second copy of the data to a database that already holds events;
 * `--reset` first empties `events`, `alerts` and `alert_events` (rule flags are kept). It
 * never runs with NODE_ENV=production.
 */
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { DEFAULT_SEED, generate } from '@centinela/loggen';
import { ConfigError, loadConfig } from '../packages/server/src/config.js';
import { checkScenarios } from '../packages/server/src/db/ground-truth.js';
import { runMigrations } from '../packages/server/src/db/migrate.js';
import { createPool } from '../packages/server/src/db/pool.js';
import { redactUrl } from '../packages/server/src/db/url.js';
import { createDetector } from '../packages/server/src/detection/index.js';
import { loadDotEnv } from '../packages/server/src/env.js';
import { createLogger } from '../packages/server/src/logger.js';
import { repoRoot } from '../packages/server/src/paths.js';
import { createPipeline } from '../packages/server/src/pipeline/index.js';
import { replayFiles } from '../packages/server/src/pipeline/replay.js';
import { createRuleCatalog } from '../packages/server/src/pipeline/rule-catalog.js';

const DAYS = 3;
const HOUR_MS = 60 * 60 * 1000;
const LEVELS = ['critical', 'high', 'medium', 'low', 'informational'] as const;

const USAGE = `Usage: npm run demo [-- --reset]

Generates three days of demo logs (seed ${DEFAULT_SEED}) ending at the current hour, ingests
them into DATABASE_URL through the detection pipeline and prints a detection summary.

  --reset   empty events, alerts and alert_events first (rule flags are kept)
  --help    show this help
`;

function parseOptions(argv: string[]): { reset: boolean } | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return values.help ? 'help' : { reset: values.reset };
}

const print = (line = '') => process.stdout.write(`${line}\n`);

async function main(argv: string[]): Promise<number> {
  let options: { reset: boolean } | 'help';
  try {
    options = parseOptions(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (options === 'help') {
    print(USAGE);
    return 0;
  }

  loadDotEnv();
  const config = loadConfig();
  if (config.isProduction) {
    process.stderr.write(
      'npm run demo loads synthetic data; it refuses to run with NODE_ENV=production.\n',
    );
    return 1;
  }

  print(`Database: ${redactUrl(config.databaseUrl)}`);
  const applied = await runMigrations({ databaseUrl: config.databaseUrl });
  print(
    applied.length === 0 ? 'Migrations: up to date' : `Migrations applied: ${applied.join(', ')}`,
  );

  const pool = createPool(config.databaseUrl, createLogger({ logLevel: 'warn' }));
  try {
    const existing = await pool.query<{ count: string }>('SELECT count(*) AS count FROM events');
    const events = Number(existing.rows[0]?.count ?? 0);
    if (events > 0 && !options.reset) {
      process.stderr.write(
        `The database already holds ${events} events. Run \`npm run demo -- --reset\` to replace them with a fresh demo data set.\n`,
      );
      return 1;
    }
    if (options.reset) {
      await pool.query('TRUNCATE alert_events, alerts, events');
      print('Reset: events, alerts and alert links removed (rule flags kept)');
    }

    // Whole hours keep the data set identical within an hour; it ends at the current hour.
    const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - DAYS * 24 * HOUR_MS;
    let started = performance.now();
    const sample = generate({ seed: DEFAULT_SEED, days: DAYS, startMs, small: false });
    print(
      `Generated ${sample.lines.length} lines (seed ${DEFAULT_SEED}, ${new Date(startMs).toISOString()} to ` +
        `${new Date(startMs + DAYS * 24 * HOUR_MS).toISOString()}) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );

    const engine = createDetector({ rulesDir: join(repoRoot, 'rules') });
    const rules = createRuleCatalog({ engine, pool });
    const pipeline = createPipeline({ pool, detector: engine, rules });
    started = performance.now();
    const result = await replayFiles(
      pipeline,
      sample.files.map((file) => ({
        path: file.path,
        source: file.file === 'auth' ? 'linux_auth' : 'nginx_access',
        host: file.host,
        lines: file.content.split('\n'),
      })),
    );
    const seconds = (performance.now() - started) / 1000;
    print();
    print('Ingested:');
    for (const { path, summary } of result.files) {
      print(
        `  ${path.padEnd(22)} ${String(summary.accepted).padStart(7)} events  ` +
          `${String(summary.rejected).padStart(3)} rejected  ${String(summary.alertsCreated).padStart(4)} alerts`,
      );
    }
    print(
      `  total: ${result.accepted} events, ${result.rejected} rejected, ${result.alertsCreated} alerts ` +
        `created, ${result.alertsUpdated} updated in ${seconds.toFixed(1)} s (${Math.round(result.accepted / seconds)} events/s)`,
    );

    const byLevel = await pool.query<{ level: string; count: string }>(
      'SELECT level, count(*) AS count FROM alerts GROUP BY level',
    );
    const counts = new Map(byLevel.rows.map((row) => [row.level, row.count]));
    print(
      `  alerts by level: ${LEVELS.map((level) => `${level} ${counts.get(level) ?? 0}`).join(', ')}`,
    );

    const results = await checkScenarios(pool, sample.groundTruth.scenarios, rules.list());
    print();
    print('Scenarios (ground truth):');
    for (const scenario of results) {
      const detail = scenario.rules.map((rule) => `${rule.expected} (${rule.alerts})`).join(', ');
      print(`  ${scenario.detected ? 'ok     ' : 'MISSED '} ${scenario.id.padEnd(20)} ${detail}`);
    }
    const detected = results.filter((scenario) => scenario.detected).length;
    print();
    print(`detected ${detected}/${results.length} scenarios`);
    print();
    print(
      'Open the dashboard: http://localhost:8080 (docker compose) or http://localhost:5173 (npm run dev).',
    );
    print('The default view shows the last 24 hours; pick "Last 7 days" to see every scenario.');
    return detected === results.length ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`demo failed: ${message}\n`);
    process.exitCode = 1;
  },
);
