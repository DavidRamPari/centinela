/**
 * `npm run bench`: events per second through the detection engine for a Linux/web mix and
 * a Windows process-creation mix. Rule loading and event construction are not timed; a
 * short warm-up run precedes each measurement. Exit codes: 0 success, 1 runtime error,
 * 2 bad arguments.
 */
import { linuxWebEvents, measure, windowsEvents, type BenchResult } from '../bench.js';
import { loadRuleSet } from '../index.js';
import { readRegressionSamples } from '../regression.js';
import { BENCH_USAGE, parseBenchArgs, type BenchArgs } from './args.js';

const WARM_UP_EVENTS = 5_000;

function format(name: string, result: BenchResult): string {
  const seconds = (result.durationMs / 1000).toFixed(2);
  return `${name.padEnd(28)} ${result.events.toLocaleString('en-US')} events in ${seconds} s = ${result.eventsPerSecond.toLocaleString('en-US')} events/s (${result.candidates.toLocaleString('en-US')} alert candidates)`;
}

function main(argv: string[]): number {
  let args: BenchArgs | 'help';
  try {
    args = parseBenchArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${BENCH_USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(BENCH_USAGE);
    return 0;
  }
  try {
    const loadStarted = performance.now();
    const ruleSet = loadRuleSet(args.rulesDir);
    const loadMs = performance.now() - loadStarted;
    process.stdout.write(
      `npm run bench: ${ruleSet.sigma.length} Sigma rules and ${ruleSet.correlations.length} correlation rules compiled in ${(loadMs / 1000).toFixed(2)} s (node ${process.version})\n`,
    );
    const mixes: Array<{ name: string; build: (n: number) => ReturnType<typeof linuxWebEvents> }> =
      [];
    if (args.mix !== 'windows') mixes.push({ name: 'linux/web mix', build: linuxWebEvents });
    if (args.mix !== 'linux-web') {
      const samples = readRegressionSamples(args.rulesDir);
      mixes.push({ name: 'windows process_creation mix', build: (n) => windowsEvents(n, samples) });
    }
    for (const mix of mixes) {
      measure(ruleSet, mix.build(Math.min(WARM_UP_EVENTS, args.events)));
      process.stdout.write(`${format(mix.name, measure(ruleSet, mix.build(args.events)))}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`bench failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
