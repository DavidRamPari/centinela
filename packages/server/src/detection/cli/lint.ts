/**
 * `npm run rules:lint`: check Sigma rules for conditions that can never match (S9).
 * Findings listed in the baseline (`rules/lint-baseline.json` for Centinela's rules) are
 * known; anything else is new. Exit codes: 0 every file checked and no new finding; 1 new
 * findings, stale baseline entries, files that could not be checked or a runtime error;
 * 2 bad arguments.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  compareWithBaseline,
  lintFolder,
  parseLintBaseline,
  type LintBaseline,
  type LintFinding,
} from '../lint.js';
import { LINT_USAGE, parseLintArgs, type LintArgs } from './args.js';

const number = new Intl.NumberFormat('en-US');

function count(n: number, noun: string): string {
  return `${number.format(n)} ${noun}${n === 1 ? '' : 's'}`;
}

function describe(finding: LintFinding): string {
  return `    ${finding.selection}: ${finding.key}: '${finding.value}'  [${finding.check}] ${finding.message}`;
}

function grouped(findings: readonly LintFinding[], note: (f: LintFinding) => string): string {
  const lines: string[] = [];
  let file = '';
  for (const finding of findings) {
    if (finding.file !== file) {
      file = finding.file;
      lines.push(`  ${file}${finding.title === null ? '' : ` (${finding.title})`}`);
    }
    lines.push(`${describe(finding)}${note(finding)}`);
  }
  return lines.join('\n');
}

function main(argv: string[]): number {
  let args: LintArgs | 'help';
  try {
    args = parseLintArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${LINT_USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(LINT_USAGE);
    return 0;
  }
  try {
    const baseline: LintBaseline | null =
      args.baseline === null ? null : parseLintBaseline(readFileSync(args.baseline, 'utf8'));
    const result = lintFolder(args.rulesDir);
    const comparison = compareWithBaseline(result.findings, baseline);
    const where = relative(process.env['INIT_CWD'] ?? process.cwd(), args.rulesDir) || '.';
    const out: string[] = [
      'npm run rules:lint',
      `checked ${count(result.rules, 'rule')} in ${count(result.files, 'YAML file')} under ${where}`,
      `findings: ${number.format(result.findings.length)} (known: ${number.format(comparison.known.length)}, new: ${number.format(comparison.unknown.length)})`,
    ];
    if (baseline !== null) {
      out.push(`stale baseline entries: ${number.format(comparison.stale.length)}`);
    }
    if (result.errors.length > 0) {
      out.push(`files not checked: ${number.format(result.errors.length)}`);
    }
    if (comparison.known.length > 0) {
      const upstream = new Map(comparison.known.map((k) => [k.finding, k.entry.upstream]));
      out.push('', 'Known (in the baseline):');
      out.push(
        grouped(
          comparison.known.map((k) => k.finding),
          (f) => ` (${upstream.get(f) ?? ''})`,
        ),
      );
    }
    if (comparison.unknown.length > 0) {
      out.push(
        '',
        'New:',
        grouped(comparison.unknown, () => ''),
      );
    }
    if (comparison.stale.length > 0) {
      out.push('', 'Stale baseline entries (no longer found; remove them from the baseline):');
      for (const entry of comparison.stale) {
        out.push(`  ${entry.file}: ${entry.key} [${entry.check}] ${entry.upstream}`);
      }
    }
    if (result.errors.length > 0) {
      out.push('', 'Not checked (invalid YAML or larger than 1 MB):');
      for (const error of result.errors) out.push(`  ${error.file}: ${error.error}`);
    }
    process.stdout.write(`${out.join('\n')}\n`);
    const clean =
      comparison.unknown.length === 0 &&
      comparison.stale.length === 0 &&
      result.errors.length === 0;
    return clean ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `rules:lint failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
