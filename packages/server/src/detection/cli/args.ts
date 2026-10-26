/** Command-line options of `npm run rules:report` and `npm run bench`. */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { repoRoot } from '../../paths.js';

export const REPORT_USAGE = `Usage: npm run rules:report -- [options]

Loads every rule, prints loaded and skipped counts by folder and reason, runs the SigmaHQ
regression samples and writes the full report.

Options:
  --rules-dir <path>  rules folder (default: <repo>/rules)
  --out <path>        report file (default: <repo>/docs/rules-report.md)
  -h, --help          show this help
`;

export const BENCH_USAGE = `Usage: npm run bench -- [options]

Measures events per second through the detection engine (rule loading excluded).

Options:
  --events <n>        events per mix (default: 100000)
  --mix <name>        linux-web, windows or all (default: all)
  --rules-dir <path>  rules folder (default: <repo>/rules)
  -h, --help          show this help
`;

/** Relative paths are relative to where `npm run` was started (`npm run -w` changes cwd). */
function fromInvocationDir(path: string): string {
  return resolve(process.env['INIT_CWD'] ?? process.cwd(), path);
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `--${i.path.join('.')}: ${i.message}`).join('\n');
}

export interface ReportArgs {
  rulesDir: string;
  out: string;
}

export function parseReportArgs(argv: string[]): ReportArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      'rules-dir': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const schema = z.object({ rulesDir: z.string().min(1), out: z.string().min(1) });
  const result = schema.safeParse({
    rulesDir: values['rules-dir'] ?? join(repoRoot, 'rules'),
    out: values.out ?? join(repoRoot, 'docs', 'rules-report.md'),
  });
  if (!result.success) throw new Error(formatIssues(result.error));
  return {
    rulesDir: fromInvocationDir(result.data.rulesDir),
    out: fromInvocationDir(result.data.out),
  };
}

export const BENCH_MIXES = ['linux-web', 'windows', 'all'] as const;

export interface BenchArgs {
  events: number;
  mix: (typeof BENCH_MIXES)[number];
  rulesDir: string;
}

export function parseBenchArgs(argv: string[]): BenchArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      events: { type: 'string' },
      mix: { type: 'string' },
      'rules-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const schema = z.object({
    events: z.coerce.number().int().min(1).max(10_000_000),
    mix: z.enum(BENCH_MIXES),
    rulesDir: z.string().min(1),
  });
  const result = schema.safeParse({
    events: values.events ?? 100_000,
    mix: values.mix ?? 'all',
    rulesDir: values['rules-dir'] ?? join(repoRoot, 'rules'),
  });
  if (!result.success) throw new Error(formatIssues(result.error));
  return { ...result.data, rulesDir: fromInvocationDir(result.data.rulesDir) };
}
