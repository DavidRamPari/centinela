/**
 * `npm run content:validate`: evaluate every content-pack fixture against its rule, write
 * `docs/content-pack-report.md` and the failures file, and with `--prune` move failing
 * fixtures to the rejected folder. Exit codes: 0 success (even with failing fixtures; the
 * regression suite in `npm test` enforces them), 1 runtime error, 2 bad arguments.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFailuresFile } from '../failures.js';
import { pruneFailures, writeJsonAtomic } from '../prune.js';
import { buildContentReport, contentSummary } from '../report.js';
import { loadSigmaFolder } from '../rules.js';
import { readContentDir, validateContent } from '../validate.js';
import { displayPath, parseValidateArgs, VALIDATE_USAGE, type ValidateArgs } from './args.js';

function requireDirectory(path: string, option: string): void {
  let ok: boolean;
  try {
    ok = statSync(path).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${option}: not a directory: ${path}`);
}

function main(argv: string[]): number {
  let args: ValidateArgs | 'help';
  try {
    args = parseValidateArgs(argv);
    if (args !== 'help') {
      requireDirectory(args.rulesDir, '--rules');
      requireDirectory(args.contentDir, '--content');
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${VALIDATE_USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(VALIDATE_USAGE);
    return 0;
  }
  try {
    const started = performance.now();
    const folder = loadSigmaFolder(args.rulesDir);
    const validation = validateContent(folder, readContentDir(args.contentDir));
    const shown = {
      rulesDir: displayPath(args.rulesDir),
      contentDir: displayPath(args.contentDir),
    };
    const failures = buildFailuresFile(validation, { ...shown, pruned: args.prune });
    mkdirSync(dirname(args.out), { recursive: true });
    writeJsonAtomic(args.out, failures);
    mkdirSync(dirname(args.report), { recursive: true });
    writeFileSync(
      args.report,
      buildContentReport(validation, {
        ...shown,
        failuresFile: displayPath(args.out),
        pruned: args.prune,
      }),
    );
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    process.stdout.write(`npm run content:validate (${seconds} s)\n${contentSummary(validation)}\n`);
    process.stdout.write(`Wrote ${args.report}\nWrote ${args.out} (${failures.failures.length} failing fixtures)\n`);
    if (args.prune) {
      const pruned = pruneFailures(args.contentDir, args.rejectedDir, validation.evaluated);
      process.stdout.write(
        `Pruned ${pruned.fixtures} fixtures from ${pruned.files} files into ${args.rejectedDir}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`content:validate failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
