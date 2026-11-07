/** Command-line options of `npm run rules:report`, `npm run rules:lint` and `npm run bench`. */
import { existsSync } from 'node:fs';
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

/** Zod issues named after the command-line option (`rulesDir` → `--rules-dir`). */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const option = i.path
        .map(String)
        .join('.')
        .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return `--${option}: ${i.message}`;
    })
    .join('\n');
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

export const LINT_USAGE = `Usage: npm run rules:lint -- [options]

Checks Sigma rules for conditions that can never match: path values that are not full
paths, that end with a folder separator or that use another system's separator;
startswith values that no path can begin with; OriginalFileName values with a folder;
exact command lines with a leading or trailing space; registry numbers without 0x; and
exact values that another condition on the same field rules out. The checks are
described in docs/DETECTION.md#rule-lint.

Options:
  --rules-dir <path>  folder to check: Centinela's rules folder or any folder of Sigma
                      rules, such as a SigmaHQ checkout (default: <repo>/rules)
  --baseline <path>   known findings to accept (default: <rules-dir>/lint-baseline.json
                      when that file exists)
  --no-baseline       report every finding as new
  -h, --help          show this help

Exit codes: 0 every file checked and no new finding; 1 new findings, stale baseline
entries, files that could not be checked (invalid YAML) or an error; 2 bad arguments.
`;

export interface LintArgs {
  rulesDir: string;
  /** null: no baseline. */
  baseline: string | null;
}

export function parseLintArgs(argv: string[]): LintArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      'rules-dir': { type: 'string' },
      baseline: { type: 'string' },
      'no-baseline': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  if (values['no-baseline'] && values.baseline !== undefined) {
    throw new Error('--baseline and --no-baseline cannot be used together');
  }
  const schema = z.object({ rulesDir: z.string().min(1), baseline: z.string().min(1).optional() });
  const result = schema.safeParse({
    rulesDir: values['rules-dir'] ?? join(repoRoot, 'rules'),
    baseline: values.baseline,
  });
  if (!result.success) throw new Error(formatIssues(result.error));
  const rulesDir = fromInvocationDir(result.data.rulesDir);
  if (values['no-baseline']) return { rulesDir, baseline: null };
  if (result.data.baseline !== undefined) {
    return { rulesDir, baseline: fromInvocationDir(result.data.baseline) };
  }
  const defaultBaseline = join(rulesDir, 'lint-baseline.json');
  return { rulesDir, baseline: existsSync(defaultBaseline) ? defaultBaseline : null };
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
