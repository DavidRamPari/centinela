/**
 * The demo data against the real rules: loggen output → S1 parsers → the detector → the
 * in-memory alert sink. Every ground-truth scenario must raise each of its expected alerts
 * for its entities and time range, and background traffic must raise no high or critical
 * alert (S4 repeats this through PostgreSQL). loggen is imported by relative path, as in
 * `test/samples/`, so the server's dependencies stay unchanged.
 */
import { join } from 'node:path';
import type { Alert, NormalizedEvent, SourceType } from '@centinela/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FILE_SOURCES,
  generate,
  type GenerationResult,
  type ScenarioTruth,
} from '../../../loggen/src/index.js';
import { createDetector } from '../../src/detection/index.js';
import { createParserRegistry } from '../../src/parsers/index.js';
import { repoRoot } from '../../src/paths.js';
import { createMemoryAlertSink, type MemoryAlertSink } from '../../src/pipeline/memory-sink.js';

const START_MS = Date.parse('2026-10-20T00:00:00Z');
const RECEIVED_AT = new Date('2026-10-26T00:00:00Z');

interface Run {
  result: GenerationResult;
  sink: MemoryAlertSink;
  /** Event id → scenario id (null for background). */
  scenarioOf: Map<string, string | null>;
  nameOf: Map<string, string>;
  candidates: number;
}

async function detect(small: boolean): Promise<Run> {
  const result = generate({ seed: 42, days: 3, startMs: START_MS, small });
  const parsers = createParserRegistry();
  const events: NormalizedEvent[] = [];
  const scenarioOf = new Map<string, string | null>();
  result.lines.forEach((line, i) => {
    const source: SourceType = FILE_SOURCES[line.file];
    const parsed = parsers.get(source)?.parse(line.text, {
      source,
      host: line.host,
      receivedAt: RECEIVED_AT,
      timezone: 'UTC',
    });
    if (!parsed?.ok) throw new Error(`unparsed line: ${line.text}`);
    const id = `01930f6e-8a4b-7c2d-9e1f-${i.toString(16).padStart(12, '0')}`;
    events.push({ ...parsed.event, id, ingestedAt: RECEIVED_AT.toISOString() });
    scenarioOf.set(id, line.scenario);
  });
  // The orchestrator sorts each batch by event time; here the whole stream is sorted.
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const detector = createDetector({ rulesDir: join(repoRoot, 'rules') });
  const sink = createMemoryAlertSink({ now: () => RECEIVED_AT });
  const candidates = events.flatMap((event) => detector.process(event));
  const last = events[events.length - 1];
  if (last) candidates.push(...detector.flush(new Date(last.ts)));
  await sink.upsert(candidates);
  const nameOf = new Map(
    detector.rules().map((r) => [
      r.id,
      r.name ??
        r.path
          .split('/')
          .pop()
          ?.replace(/\.yml$/, '') ??
        r.id,
    ]),
  );
  return { result, sink, scenarioOf, nameOf, candidates: candidates.length };
}

function alertsFor(run: Run, truth: ScenarioTruth, expected: string): Alert[] {
  const from = Date.parse(truth.start);
  const to = Date.parse(truth.end);
  return run.sink.list().filter((alert) => {
    if (run.nameOf.get(alert.ruleId) !== expected) return false;
    if (Date.parse(alert.lastSeen) < from || Date.parse(alert.firstSeen) > to) return false;
    const ips = truth.entities.ips.some((ip) => alert.entities.ips.includes(ip));
    const users = truth.entities.users.some((user) => alert.entities.users.includes(user));
    return truth.entities.ips.length === 0 && truth.entities.users.length === 0
      ? true
      : ips || users;
  });
}

describe.each([
  ['small sample', true],
  ['default 3-day sample', false],
])('demo data: %s', (_label, small) => {
  let run: Run;
  beforeAll(async () => {
    run = await detect(small);
  }, 120_000);

  it('detects every ground-truth scenario with each expected rule', () => {
    const missing: string[] = [];
    for (const truth of run.result.groundTruth.scenarios) {
      for (const expected of truth.expected) {
        if (alertsFor(run, truth, expected).length === 0) missing.push(`${truth.id} → ${expected}`);
      }
    }
    const total = run.result.groundTruth.scenarios.length;
    console.log(
      `detected ${total - new Set(missing.map((m) => m.split(' ')[0])).size}/${total} scenarios`,
    );
    expect(missing).toEqual([]);
  });

  it('raises no high or critical alert from background traffic alone', () => {
    const background = run.sink
      .list()
      .filter((alert) => alert.level === 'high' || alert.level === 'critical')
      .filter((alert) => run.sink.eventIds(alert.id).every((id) => run.scenarioOf.get(id) === null))
      .map((alert) => `${run.nameOf.get(alert.ruleId) ?? alert.ruleId} ${alert.firstSeen}`);
    expect(background).toEqual([]);
  });
});

describe('demo data: determinism', () => {
  it('the same sample gives the same alerts in the same order', async () => {
    const [first, second] = [await detect(true), await detect(true)];
    const strip = (alerts: Alert[]) => alerts.map(({ id: _id, ...rest }) => rest);
    expect(strip(second.sink.list())).toEqual(strip(first.sink.list()));
    expect(second.candidates).toBe(first.candidates);
  }, 120_000);
});
