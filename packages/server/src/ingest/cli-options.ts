/** Command-line options and output of `npm run ingest` (see `cli.ts`). */
import { parseArgs } from 'node:util';
import { ingestQuerySchema } from '@centinela/shared';
import { z } from 'zod';
import type { IngestSummary } from '../pipeline/types.js';

export const USAGE = `Usage: npm run ingest -- --source <linux_auth|nginx_access|apache_access> --host <name> --file <path> [options]

Options:
  --source <type>   log type (required)
  --file <path>     log file to ingest (required)
  --host <name>     default host for lines that do not carry one (default: unknown)
  --tz <zone>       IANA time zone for timestamps without an offset (default: UTC)
  --year <yyyy>     year for RFC 3164 timestamps (default: the current year)
  --parse-only      parse without storing or detecting (measures parser throughput)
  -h, --help        show this help
`;

const argsSchema = ingestQuerySchema.extend({
  file: z.string().min(1, '--file is required'),
  year: z.coerce.number().int().min(1970).max(9999).optional(),
  parseOnly: z.boolean(),
});
export type IngestCliArgs = z.infer<typeof argsSchema>;

/** Parse and validate the command line; throws an Error with a readable message. */
export function parseCliArgs(argv: string[]): IngestCliArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      host: { type: 'string' },
      file: { type: 'string' },
      tz: { type: 'string' },
      year: { type: 'string' },
      'parse-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const result = argsSchema.safeParse({
    source: values.source,
    host: values.host,
    file: values.file ?? '',
    tz: values.tz,
    year: values.year,
    parseOnly: values['parse-only'],
  });
  if (!result.success) {
    const issues = result.error.issues.map((i) => `--${i.path.join('.')}: ${i.message}`);
    throw new Error(issues.join('\n'));
  }
  return result.data;
}

export function formatSummary(file: string, summary: IngestSummary, parseOnly: boolean): string {
  const lines = summary.accepted + summary.rejected;
  const seconds = summary.durationMs / 1000;
  const rate = seconds > 0 ? Math.round(lines / seconds) : lines;
  const out = [
    `${parseOnly ? 'Parsed' : 'Ingested'} ${file}`,
    `  lines:     ${lines}`,
    `  accepted:  ${summary.accepted}`,
    `  rejected:  ${summary.rejected}`,
  ];
  if (!parseOnly) {
    out.push(`  alerts:    ${summary.alertsCreated} created, ${summary.alertsUpdated} updated`);
  }
  out.push(`  duration:  ${seconds.toFixed(2)} s`, `  speed:     ${rate} lines/s`);
  for (const r of summary.rejections) out.push(`  rejected line ${r.line}: ${r.reason}`);
  return `${out.join('\n')}\n`;
}
