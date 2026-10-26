/**
 * SigmaHQ regression samples (ARCHITECTURE §4.4): Sysmon process-creation events that must
 * match their rule. Each file is `<rule folder>/<rule id>.json` below
 * `rules/sigma/regression/windows/process_creation/` and holds one or more pretty-printed
 * objects. `Event.EventData` is the field view, as in SigmaHQ's field mapping pipeline.
 * The golden test and `npm run rules:report` both use this module.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldValue, LogSource } from '@centinela/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EventView, MAX_MATCH_LENGTH } from './event-view.js';
import { parseConcatenatedJson } from './json-stream.js';
import type { RuleSet } from './rules/ruleset.js';

export const REGRESSION_DIR = 'sigma/regression/windows/process_creation';
export const PROCESS_CREATION: LogSource = { product: 'windows', category: 'process_creation' };

export interface RegressionSample {
  /** Repository-relative path of the JSON file. */
  path: string;
  /** Rule file name without `.yml` (the folder name). */
  ruleName: string;
  ruleId: string;
  /** Position of the object in the file (0-based). */
  index: number;
  fields: Record<string, FieldValue>;
}

export interface RegressionResult {
  sample: RegressionSample;
  passed: boolean;
  /** Why the sample failed; null when it passed. */
  reason: string | null;
}

const sampleSchema = z.object({
  Event: z.object({ EventData: z.record(z.string(), z.unknown()) }),
});

function toFields(data: Record<string, unknown>): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      fields[key] = value;
    } else {
      fields[key] = JSON.stringify(value);
    }
  }
  return fields;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function readRegressionSamples(rulesDir: string): RegressionSample[] {
  const root = join(rulesDir, REGRESSION_DIR);
  let folders: string[];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byName);
  } catch {
    return [];
  }
  const samples: RegressionSample[] = [];
  for (const folder of folders) {
    const files = readdirSync(join(root, folder))
      .filter((f) => f.endsWith('.json'))
      .sort(byName);
    for (const file of files) {
      const path = `rules/${REGRESSION_DIR}/${folder}/${file}`;
      const objects = parseConcatenatedJson(readFileSync(join(root, folder, file), 'utf8'));
      objects.forEach((object, index) => {
        const parsed = sampleSchema.parse(object);
        samples.push({
          path,
          ruleName: folder,
          ruleId: file.slice(0, -'.json'.length),
          index,
          fields: toFields(parsed.Event.EventData),
        });
      });
    }
  }
  return samples;
}

export function evaluateRegressionSample(
  ruleSet: RuleSet,
  sample: RegressionSample,
): RegressionResult {
  const fail = (reason: string): RegressionResult => ({ sample, passed: false, reason });
  const record = ruleSet.rule(sample.ruleId);
  if (!record) return fail('rule not loaded');
  if (!record.meta.supported)
    return fail(`rule unsupported: ${record.meta.unsupportedReason ?? ''}`);
  const rule = record.compiled;
  if (rule?.kind !== 'sigma') return fail('not a Sigma rule');
  if (!ruleSet.router.route([PROCESS_CREATION]).includes(rule)) {
    return fail('logsource does not apply to windows/process_creation');
  }
  const message = JSON.stringify(sample.fields).slice(0, MAX_MATCH_LENGTH);
  const view = new EventView({ message, fields: sample.fields }, ruleSet.memoSlots);
  if (rule.detection.matches(view)) return { sample, passed: true, reason: null };
  const selections = rule.detection
    .explain(view)
    .map(({ name, matched }) => `${name}=${matched}`)
    .join(', ');
  return fail(`condition false (${selections})`);
}

export function evaluateRegression(ruleSet: RuleSet, rulesDir: string): RegressionResult[] {
  return readRegressionSamples(rulesDir).map((sample) => evaluateRegressionSample(ruleSet, sample));
}

const infoSchema = z.object({
  regression_tests_info: z
    .array(z.object({ match_count: z.number().int().min(0).optional() }))
    .optional(),
});

/**
 * Matches SigmaHQ expects from a sample file: the largest `match_count` in the folder's
 * `info.yml`, or 1. Files holding several events may include context events (a parent
 * process, say) that are not supposed to match.
 */
export function readExpectedMatches(rulesDir: string, ruleName: string): number {
  try {
    const text = readFileSync(join(rulesDir, REGRESSION_DIR, ruleName, 'info.yml'), 'utf8');
    const info = infoSchema.parse(parseYaml(text));
    const counts = (info.regression_tests_info ?? []).map((t) => t.match_count ?? 0);
    return Math.max(1, ...counts);
  } catch {
    return 1;
  }
}

export interface RegressionFileResult {
  path: string;
  ruleName: string;
  events: number;
  matched: number;
  expected: number;
  passed: boolean;
}

/** Per-file view: a file passes when at least its expected number of events match. */
export function summarizeRegressionFiles(
  results: readonly RegressionResult[],
  rulesDir: string,
): RegressionFileResult[] {
  const files = new Map<string, RegressionFileResult>();
  for (const { sample, passed } of results) {
    let file = files.get(sample.path);
    if (!file) {
      const expected = readExpectedMatches(rulesDir, sample.ruleName);
      file = {
        path: sample.path,
        ruleName: sample.ruleName,
        events: 0,
        matched: 0,
        expected,
        passed: false,
      };
      files.set(sample.path, file);
    }
    file.events += 1;
    if (passed) file.matched += 1;
  }
  for (const file of files.values()) {
    file.passed = file.matched >= Math.min(file.expected, file.events);
  }
  return [...files.values()];
}
