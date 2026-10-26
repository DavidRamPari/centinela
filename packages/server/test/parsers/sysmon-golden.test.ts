/**
 * Golden test through the real ingest path (PLAN S5): every SigmaHQ regression sample in
 * `rules/sigma/regression/windows/process_creation/` is read with the streaming decoder
 * (the files are pretty-printed and some hold several objects), written as one JSON line,
 * and pushed through `createPipeline()`: the sysmon parser, the detector with every
 * repository rule, and the in-memory alert sink. A sample is detected when an alert of
 * its rule links its event.
 *
 * S2's golden test builds events straight from `Event.EventData`; this one must reach the
 * same verdict for every sample, in both the nested shape and the flat shape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedEvent } from '@centinela/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDetector } from '../../src/detection/index.js';
import { parseConcatenatedJson } from '../../src/detection/json-stream.js';
import {
  evaluateRegression,
  readExpectedMatches,
  REGRESSION_DIR,
} from '../../src/detection/regression.js';
import { repoRoot } from '../../src/paths.js';
import { createMemoryAlertSink, type MemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import { createPipeline } from '../../src/pipeline/index.js';
import type { EventStore } from '../../src/pipeline/types.js';

const rulesDir = join(repoRoot, 'rules');
const RECEIVED_AT = new Date('2026-10-26T00:00:00Z');

interface Sample {
  /** Repository-relative path of the regression file. */
  path: string;
  ruleName: string;
  ruleId: string;
  index: number;
  object: Record<string, unknown>;
}

function readSamples(): Sample[] {
  const root = join(rulesDir, REGRESSION_DIR);
  const samples: Sample[] = [];
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    for (const file of readdirSync(join(root, folder))
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const text = readFileSync(join(root, folder, file), 'utf8');
      parseConcatenatedJson(text).forEach((object, index) => {
        samples.push({
          path: `rules/${REGRESSION_DIR}/${folder}/${file}`,
          ruleName: folder,
          ruleId: file.slice(0, -'.json'.length),
          index,
          object: object as Record<string, unknown>,
        });
      });
    }
  }
  return samples;
}

/** The nested sample rewritten in the flat shape: envelope keys next to the event data. */
function flatten(object: Record<string, unknown>): Record<string, unknown> {
  const event = object.Event as {
    System: { EventID: unknown; Computer?: unknown };
    EventData: Record<string, unknown>;
  };
  return { EventID: event.System.EventID, Computer: event.System.Computer, ...event.EventData };
}

interface Verdict {
  key: string;
  detected: boolean;
}

/** One ingest call per sample, so each call's stored event is the sample's event. */
async function runThroughPipeline(
  samples: readonly Sample[],
  shape: (object: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ verdicts: Verdict[]; rejected: number; sink: MemoryAlertSink }> {
  const stored: NormalizedEvent[] = [];
  const eventStore: EventStore = {
    insertMany: (events) => {
      stored.push(...events);
      return Promise.resolve();
    },
  };
  const sink = createMemoryAlertSink({ now: () => RECEIVED_AT });
  const pipeline = createPipeline({
    detector: createDetector({ rulesDir }),
    eventStore,
    alertSink: sink,
  });
  const eventOf = new Map<string, string>();
  let rejected = 0;
  for (const sample of samples) {
    const before = stored.length;
    const summary = await pipeline.ingest([JSON.stringify(shape(sample.object))], {
      source: 'sysmon',
      host: 'unknown',
      receivedAt: RECEIVED_AT,
      timezone: 'UTC',
    });
    rejected += summary.rejected;
    const event = stored[before];
    if (stored.length === before + 1 && event) eventOf.set(keyOf(sample), event.id);
  }
  const linked = new Set<string>();
  for (const alert of sink.list()) {
    for (const id of sink.eventIds(alert.id)) linked.add(`${alert.ruleId}|${id}`);
  }
  const verdicts = samples.map((sample) => {
    const eventId = eventOf.get(keyOf(sample));
    return {
      key: keyOf(sample),
      detected: eventId !== undefined && linked.has(`${sample.ruleId}|${eventId}`),
    };
  });
  return { verdicts, rejected, sink };
}

const keyOf = (sample: Sample) => `${sample.path}#${sample.index}`;

function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

describe('golden: SigmaHQ regression samples through parse → detect (sysmon parser)', () => {
  const samples = readSamples();
  let nested: Awaited<ReturnType<typeof runThroughPipeline>>;
  let flat: Awaited<ReturnType<typeof runThroughPipeline>>;

  beforeAll(async () => {
    nested = await runThroughPipeline(samples, (object) => object);
    flat = await runThroughPipeline(samples, flatten);
  }, 120_000);

  it('reads every sample file and parses every event', () => {
    expect(new Set(samples.map((s) => s.path)).size).toBe(267);
    expect(samples.length).toBeGreaterThan(267);
    expect(nested.rejected).toBe(0);
    expect(flat.rejected).toBe(0);
  });

  it('detects at least 95% of the samples', () => {
    const detected = nested.verdicts.filter((v) => v.detected).length;
    report(`detected ${detected}/${samples.length} regression samples through parse → detect`);
    expect(detected / samples.length).toBeGreaterThanOrEqual(0.95);
  });

  it('gives every file at least the matches its info.yml expects', () => {
    const byFile = new Map<string, { matched: number; events: number; ruleName: string }>();
    samples.forEach((sample, i) => {
      const file = byFile.get(sample.path) ?? { matched: 0, events: 0, ruleName: sample.ruleName };
      file.events += 1;
      if (nested.verdicts[i]?.detected) file.matched += 1;
      byFile.set(sample.path, file);
    });
    const failing = [...byFile].filter(
      ([, file]) =>
        file.matched < Math.min(readExpectedMatches(rulesDir, file.ruleName), file.events),
    );
    expect(failing.map(([path]) => path)).toEqual([]);
  });

  it('reaches the same verdict as evaluating Event.EventData directly (S2)', async () => {
    const { loadRuleSet } = await import('../../src/detection/index.js');
    const direct = evaluateRegression(loadRuleSet(rulesDir), rulesDir).map((r) => ({
      key: `${r.sample.path}#${r.sample.index}`,
      detected: r.passed,
    }));
    expect(nested.verdicts).toEqual(direct);
  });

  it('reaches the same verdict for the flat shape', () => {
    expect(flat.verdicts).toEqual(nested.verdicts);
  });

  it('attributes every alert to its rule author under DRL 1.1', () => {
    const alerts = nested.sink.list();
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.author, alert.ruleTitle).toBeTruthy();
      expect(alert.license).toBe('DRL-1.1');
      expect(alert.ruleUrl).toMatch(/^https:\/\/github\.com\/SigmaHQ\/sigma\/blob\/[0-9a-f]{40}\//);
    }
  });
});
