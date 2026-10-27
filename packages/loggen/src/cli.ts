#!/usr/bin/env node
/**
 * `npm run loggen -- [--seed n] [--days n] [--start iso] [--out dir] [--small]`: writes
 * `<out>/<host>/auth.log`, `<out>/<host>/access.log`, `<out>/<host>/sysmon.jsonl` and
 * `<out>/ground-truth.json`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generate, groundTruthJson } from './generate.js';
import { HELP_TEXT } from './help.js';
import { parseCliOptions, type CliOptions } from './options.js';

async function main(argv: string[]): Promise<number> {
  let options: CliOptions | 'help';
  try {
    options = parseCliOptions(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP_TEXT}`);
    return 2;
  }
  if (options === 'help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const started = performance.now();
  const result = generate(options);
  // `npm run -w` changes the working directory; INIT_CWD is where npm was invoked.
  const outDir = resolve(process.env.INIT_CWD ?? process.cwd(), options.out);
  for (const file of result.files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'ground-truth.json'), groundTruthJson(result.groundTruth));
  const seconds = (performance.now() - started) / 1000;

  const report = result.files.map(
    (f) => `  ${f.path.padEnd(22)} ${String(f.lineCount).padStart(8)} lines`,
  );
  process.stdout.write(
    `Generated ${result.lines.length} lines and ${result.groundTruth.scenarios.length} scenarios ` +
      `(seed ${options.seed}, ${options.small ? 'small' : `${options.days} days`}) in ${seconds.toFixed(2)} s\n` +
      `${report.join('\n')}\n  ground-truth.json\nOutput: ${outDir}\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`loggen failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
