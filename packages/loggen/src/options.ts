/** Command-line parsing for the generator (no dependencies: `node:util` only). */
import { parseArgs } from 'node:util';
import { DEFAULT_DAYS, DEFAULT_SEED, DEFAULT_START, MAX_DAYS } from './generate.js';
import type { GeneratorOptions } from './model.js';

export interface CliOptions extends GeneratorOptions {
  out: string;
}

const INTEGER = /^\d{1,10}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parse argv; returns 'help' for -h/--help and throws an Error with a readable message. */
export function parseCliOptions(argv: string[]): CliOptions | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      seed: { type: 'string' },
      days: { type: 'string' },
      start: { type: 'string' },
      out: { type: 'string' },
      small: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';

  const seedText = values.seed ?? String(DEFAULT_SEED);
  const seed = Number(seedText);
  if (!INTEGER.test(seedText) || seed > 0xffffffff) {
    throw new Error('--seed must be an integer between 0 and 4294967295');
  }
  const daysText = values.days ?? String(DEFAULT_DAYS);
  const days = Number(daysText);
  if (!INTEGER.test(daysText) || days < 1 || days > MAX_DAYS) {
    throw new Error(`--days must be an integer between 1 and ${MAX_DAYS}`);
  }
  const start = values.start ?? DEFAULT_START;
  const startMs = Date.parse(start);
  if (!ISO_DATETIME.test(start) || Number.isNaN(startMs)) {
    throw new Error('--start must be an ISO 8601 date-time with Z or an offset');
  }
  const out = values.out ?? 'samples';
  if (out.trim() === '') throw new Error('--out must not be empty');
  return { seed, days, startMs, small: values.small, out };
}
