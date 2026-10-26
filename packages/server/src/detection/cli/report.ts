/**
 * `npm run rules:report`: load every rule, run the SigmaHQ regression samples, print the
 * loaded and skipped counts by folder and reason, and write `docs/rules-report.md`.
 * Exit codes: 0 success, 1 runtime error, 2 bad arguments.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadRuleSet } from '../index.js';
import { evaluateRegression, summarizeRegressionFiles } from '../regression.js';
import { buildRulesReport, reportSummary } from '../report.js';
import { readSigmaCommit } from '../rules/loader.js';
import { parseReportArgs, REPORT_USAGE, type ReportArgs } from './args.js';

function main(argv: string[]): number {
  let args: ReportArgs | 'help';
  try {
    args = parseReportArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${REPORT_USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(REPORT_USAGE);
    return 0;
  }
  try {
    const ruleSet = loadRuleSet(args.rulesDir);
    const regression = evaluateRegression(ruleSet, args.rulesDir);
    const input = {
      ruleSet,
      sigmaCommit: readSigmaCommit(args.rulesDir),
      regression,
      regressionFiles: summarizeRegressionFiles(regression, args.rulesDir),
    };
    process.stdout.write(`npm run rules:report\n${reportSummary(input)}\n`);
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${buildRulesReport(input)}\n`);
    process.stdout.write(`Wrote ${args.out}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `rules:report failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
