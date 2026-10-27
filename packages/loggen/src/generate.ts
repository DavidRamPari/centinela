/**
 * The generator as a pure function: options in, file contents and ground truth out.
 * Everything random comes from seeded streams, so the same options always give
 * byte-identical output.
 */
import type { SourceType } from '@centinela/shared';
import { generateBackgroundAuth } from './background-auth.js';
import { generateBackgroundWeb } from './background-web.js';
import { generateBackgroundWindows } from './background-windows.js';
import {
  FILE_NAMES,
  FILE_SOURCES,
  HOSTS,
  type GeneratedLine,
  type GeneratorOptions,
  type GroundTruth,
  type Host,
  type Interval,
  type LogFile,
  type ScenarioTruth,
} from './model.js';
import { LineCollector } from './output.js';
import {
  SCENARIO_GENERATORS,
  SCENARIOS,
  SCHEDULE_HOURS,
  type ScenarioContext,
} from './scenarios.js';

export const DEFAULT_SEED = 42;
export const DEFAULT_DAYS = 3;
export const DEFAULT_START = '2026-10-20T00:00:00Z';
export const MAX_DAYS = 30;
/** `--small`: background traffic this long before and after each scenario. */
export const SMALL_MARGIN_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_DAYS = 3;

export interface GeneratedFile {
  host: Host;
  file: LogFile;
  /** The `source` to ingest the file with. */
  source: SourceType;
  /** `<host>/<file name>`, relative to the output folder. */
  path: string;
  content: string;
  lineCount: number;
}

export interface GenerationResult {
  /** Every line, each file's lines in time order (files in host order: auth, access, sysmon). */
  lines: GeneratedLine[];
  files: GeneratedFile[];
  groundTruth: GroundTruth;
}

export function validateOptions(options: GeneratorOptions): void {
  const { seed, days, startMs } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('seed must be an integer between 0 and 4294967295');
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new RangeError(`days must be an integer between 1 and ${MAX_DAYS}`);
  }
  if (!Number.isFinite(startMs)) throw new RangeError('start must be a valid date');
}

/** Merge overlapping or touching intervals (input in any order). */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.fromMs - b.fromMs);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, interval.toMs);
    else merged.push({ ...interval });
  }
  return merged;
}

function isoSecondFloor(us: number): string {
  return new Date(Math.floor(us / 1_000_000) * 1000).toISOString();
}

function isoSecondCeil(us: number): string {
  return new Date(Math.ceil(us / 1_000_000) * 1000).toISOString();
}

export function generate(options: GeneratorOptions): GenerationResult {
  validateOptions(options);
  const { seed, days, startMs, small } = options;
  const collector = new LineCollector();

  // Scenarios first: in --small mode they decide where background traffic goes.
  const ctx: ScenarioContext = { out: (id) => collector.forScenario(id), seed };
  const scale = days / SCHEDULE_DAYS;
  for (const [id, hours] of Object.entries(SCHEDULE_HOURS)) {
    const offsetSeconds = Math.round(hours * scale * 3600);
    SCENARIO_GENERATORS[id]?.(ctx, (startMs + offsetSeconds * 1000) * 1000);
  }

  const ranges = new Map<string, { min: number; max: number }>();
  for (const line of collector.lines) {
    if (line.scenario === null) continue;
    const range = ranges.get(line.scenario);
    if (range) {
      range.min = Math.min(range.min, line.tsUs);
      range.max = Math.max(range.max, line.tsUs);
    } else {
      ranges.set(line.scenario, { min: line.tsUs, max: line.tsUs });
    }
  }
  const scenarios: ScenarioTruth[] = SCENARIOS.map((meta) => {
    const range = ranges.get(meta.id);
    if (!range) throw new Error(`scenario ${meta.id} produced no lines`);
    return {
      id: meta.id,
      host: meta.host,
      techniques: [...meta.techniques],
      // Access logs have one-second precision; whole seconds keep every line inside.
      start: isoSecondFloor(range.min),
      end: isoSecondCeil(range.max),
      entities: { ips: [...meta.entities.ips], users: [...meta.entities.users] },
      expected: [...meta.expected],
    };
  });

  const intervals = small
    ? mergeIntervals(
        [...ranges.values()].map(({ min, max }) => ({
          fromMs: Math.floor(min / 1000) - SMALL_MARGIN_MS,
          toMs: Math.ceil(max / 1000) + SMALL_MARGIN_MS,
        })),
      )
    : [{ fromMs: startMs, toMs: startMs + days * DAY_MS }];
  generateBackgroundAuth(collector, seed, intervals);
  generateBackgroundWeb(collector, seed, intervals);
  generateBackgroundWindows(collector, seed, intervals);

  const byFile = new Map<string, GeneratedLine[]>();
  for (const line of collector.lines) {
    const key = `${line.host}/${line.file}`;
    const list = byFile.get(key);
    if (list) list.push(line);
    else byFile.set(key, [line]);
  }

  const files: GeneratedFile[] = [];
  const lines: GeneratedLine[] = [];
  for (const host of HOSTS) {
    for (const file of ['auth', 'access', 'sysmon'] as const) {
      const list = byFile.get(`${host}/${file}`);
      if (!list) continue;
      // Array.prototype.sort is stable: equal timestamps keep their generation order.
      list.sort((a, b) => a.tsUs - b.tsUs);
      files.push({
        host,
        file,
        source: FILE_SOURCES[file],
        path: `${host}/${FILE_NAMES[file]}`,
        content: `${list.map((line) => line.text).join('\n')}\n`,
        lineCount: list.length,
      });
      for (const line of list) lines.push(line);
    }
  }

  return {
    lines,
    files,
    groundTruth: {
      seed,
      start: new Date(startMs).toISOString(),
      days,
      small,
      scenarios,
    },
  };
}

/** `ground-truth.json` text (2-space JSON and a trailing newline). */
export function groundTruthJson(truth: GroundTruth): string {
  return `${JSON.stringify(truth, null, 2)}\n`;
}
