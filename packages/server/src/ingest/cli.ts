/**
 * `npm run ingest -- --source <type> --host <name> --file <path> [--tz <zone>]`
 *
 * Streams a log file through `createPipeline()` in batches of 1,000 lines and prints the
 * counts and the throughput. `--parse-only` skips the database and the detector, to
 * measure parsing alone. `--year` sets the year of RFC 3164 timestamps (default: the
 * current year, with December lines read in January moved one year back).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { loadDotEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { createPipeline } from '../pipeline/index.js';
import type { Detector, EventStore } from '../pipeline/types.js';
import { formatSummary, parseCliArgs, USAGE, type IngestCliArgs } from './cli-options.js';
import { readLines } from './lines.js';

const nullStore: EventStore = { insertMany: () => Promise.resolve() };
const nullDetector: Detector = { process: () => [], flush: () => [] };

async function main(argv: string[]): Promise<number> {
  let args: IngestCliArgs | 'help';
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const file = resolve(process.env.INIT_CWD ?? process.cwd(), args.file);
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a regular file');
  } catch (err) {
    process.stderr.write(`Cannot read ${file}: ${err instanceof Error ? err.message : ''}\n`);
    return 1;
  }

  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({ ...config, logLevel: 'warn' });
  const pool = args.parseOnly ? undefined : createPool(config.databaseUrl, logger);
  const pipeline = args.parseOnly
    ? createPipeline({ eventStore: nullStore, detector: nullDetector })
    : createPipeline({ pool, rulesDir: config.rulesDir });

  try {
    const summary = await pipeline.ingest(readLines(createReadStream(file)), {
      source: args.source,
      host: args.host,
      timezone: args.tz,
      receivedAt: new Date(),
      ...(args.year === undefined ? {} : { defaultYear: args.year }),
    });
    process.stdout.write(formatSummary(args.file, summary, args.parseOnly));
    return 0;
  } finally {
    await pool?.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `ingest failed: ${err instanceof ConfigError || err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
