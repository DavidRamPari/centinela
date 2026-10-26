/**
 * The generated demo data against the parsers, the database and the detection logic the
 * scenarios target. Uses loggen's `generate()` directly (no files) and the test-only
 * evaluator in `sigma-lite.ts` for the vendored SigmaHQ Linux and web rules.
 */
import { join } from 'node:path';
import { normalizedEventSchema, type NormalizedEvent, type SourceType } from '@centinela/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FILE_SOURCES,
  generate,
  type GeneratedLine,
  type GenerationResult,
} from '../../../loggen/src/index.js';
import { createParserRegistry } from '../../src/parsers/index.js';
import { createPipeline } from '../../src/pipeline/index.js';
import type { IngestContext } from '../../src/pipeline/types.js';
import { repoRoot } from '../../src/paths.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { loadLiteRules, matchingRules } from './sigma-lite.js';

const START_MS = Date.parse('2026-10-20T00:00:00Z');
const RECEIVED_AT = new Date('2026-10-26T00:00:00Z');
const parsers = createParserRegistry();

function sourceOf(line: GeneratedLine): SourceType {
  return FILE_SOURCES[line.file];
}

interface ParsedLine {
  line: GeneratedLine;
  event: NormalizedEvent;
}

function parseAll(lines: GeneratedLine[]): { parsed: ParsedLine[]; rejected: string[] } {
  const parsed: ParsedLine[] = [];
  const rejected: string[] = [];
  lines.forEach((line, i) => {
    const ctx: IngestContext = {
      source: sourceOf(line),
      host: line.host,
      receivedAt: RECEIVED_AT,
      timezone: 'America/Lima',
    };
    const result = parsers.get(ctx.source)?.parse(line.text, ctx);
    if (!result?.ok) {
      rejected.push(`${line.text} (${result?.reason ?? 'no parser'})`);
      return;
    }
    const id = `01930f6e-8a4b-7c2d-9e1f-${i.toString(16).padStart(12, '0')}`;
    parsed.push({ line, event: { ...result.event, id, ingestedAt: RECEIVED_AT.toISOString() } });
  });
  return { parsed, rejected };
}

/** Largest number of `items` (timestamps, sorted) inside any window of `windowMs`. */
function maxInWindow(times: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while ((times[end] ?? 0) - (times[start] ?? 0) > windowMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

function groupTimes(
  events: NormalizedEvent[],
  keyOf: (e: NormalizedEvent) => string | undefined,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const e of events) {
    const key = keyOf(e);
    if (key === undefined) continue;
    const list = groups.get(key) ?? [];
    list.push(Date.parse(e.ts));
    groups.set(key, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a - b);
  return groups;
}

const rules = loadLiteRules(join(repoRoot, 'rules', 'sigma'), ['linux', 'web']);
const isFailedSsh = (e: NormalizedEvent) => e.action === 'ssh_login' && e.outcome === 'failure';

describe('default sample (seed 42, 3 days)', () => {
  let result: GenerationResult;
  let parsed: ParsedLine[];
  let rejected: string[];

  beforeAll(() => {
    result = generate({ seed: 42, days: 3, startMs: START_MS, small: false });
    ({ parsed, rejected } = parseAll(result.lines));
  });

  it('is about 200,000 lines, every one parsed (unknown messages as `other`)', () => {
    expect(result.lines.length).toBeGreaterThan(180_000);
    expect(result.lines.length).toBeLessThan(230_000);
    expect(rejected).toEqual([]);
    expect(parsed).toHaveLength(result.lines.length);
  });

  it('produces events that satisfy the shared schema', () => {
    // Every 50th event keeps the zod pass fast; all event shapes appear many times.
    for (let i = 0; i < parsed.length; i += 50) {
      normalizedEventSchema.parse(parsed[i]?.event);
    }
    const actions = new Set(parsed.map((p) => p.event.action));
    for (const action of ['ssh_login', 'sudo_command', 'session_opened', 'http_request']) {
      expect(actions).toContain(action);
    }
  });

  it('keeps every scenario line inside its ground-truth time range', () => {
    for (const truth of result.groundTruth.scenarios) {
      const from = Date.parse(truth.start);
      const to = Date.parse(truth.end);
      const events = parsed.filter((p) => p.line.scenario === truth.id);
      expect(events.length, truth.id).toBeGreaterThan(0);
      for (const { event } of events) {
        const ts = Date.parse(event.ts);
        expect(ts >= from && ts <= to, `${truth.id}: ${event.message}`).toBe(true);
        expect(event.host).toBe(truth.host);
      }
    }
  });

  it('makes every expected SigmaHQ rule match a line of its scenario', () => {
    // Windows scenarios (S5) are checked with the real engine in test/detection/.
    const linuxAndWeb = result.groundTruth.scenarios.filter((s) => !s.host.startsWith('ws-'));
    for (const truth of linuxAndWeb) {
      const events = parsed.filter((p) => p.line.scenario === truth.id).map((p) => p.event);
      for (const expected of truth.expected.filter((name) => !name.startsWith('centinela-'))) {
        const rule = rules.find((r) => r.name === expected);
        expect(rule, `${expected} is vendored in rules/sigma`).toBeDefined();
        const hits = events.filter((e) => rule && matchingRules([rule], e).length > 0);
        expect(hits.length, `${truth.id} → ${expected}`).toBeGreaterThan(0);
      }
    }
  });

  it('background traffic matches no high or critical SigmaHQ rule', () => {
    const offenders = parsed
      .filter((p) => p.line.scenario === null)
      .flatMap((p) =>
        matchingRules(rules, p.event)
          .filter((r) => r.level === 'high' || r.level === 'critical')
          .map((r) => `${r.name}: ${p.event.message}`),
      );
    expect(offenders).toEqual([]);
  });

  it('background traffic stays below the correlation thresholds (ARCHITECTURE §6.1)', () => {
    const background = parsed.filter((p) => p.line.scenario === null).map((p) => p.event);
    // centinela-ssh-bruteforce: 10 failures per source.ip and host in 5 minutes.
    const failures = groupTimes(background.filter(isFailedSsh), (e) => `${e.srcIp}|${e.host}`);
    for (const times of failures.values()) expect(maxInWindow(times, 5 * 60_000)).toBeLessThan(10);
    // Staff mistype at most twice in a row.
    expect(Math.max(0, ...[...failures.values()].map((t) => maxInWindow(t, 60_000)))).toBeLessThanOrEqual(2);
    // centinela-web-scanning-burst: 50 404s per source.ip and host in 2 minutes.
    const notFound = groupTimes(
      background.filter((e) => e.fields['http.response.status_code'] === 404),
      (e) => `${e.srcIp}|${e.host}`,
    );
    for (const times of notFound.values()) expect(maxInWindow(times, 2 * 60_000)).toBeLessThan(50);
    // Neither sudo refusals nor account creation happen in the background.
    const quiet = ['sudo_not_in_sudoers', 'sudo_auth_failure', 'user_created', 'user_added_to_group'];
    expect(background.filter((e) => quiet.includes(e.action))).toEqual([]);
  });

  it('shapes the SSH scenarios around the correlation thresholds', () => {
    const scenario = (id: string) =>
      parsed.filter((p) => p.line.scenario === id).map((p) => p.event);

    const brute = scenario('ssh-bruteforce').filter(isFailedSsh);
    expect(brute).toHaveLength(300);
    const bruteTimes = brute.map((e) => Date.parse(e.ts));
    expect(Math.max(...bruteTimes) - Math.min(...bruteTimes)).toBeLessThanOrEqual(4 * 60_000);
    expect(new Set(brute.map((e) => e.user))).toEqual(new Set(['root', 'admin']));

    const spray = scenario('password-spray').filter(isFailedSsh);
    expect(new Set(spray.map((e) => e.user)).size).toBe(25);
    const sprayTimes = spray.map((e) => Date.parse(e.ts)).sort((a, b) => a - b);
    expect(maxInWindow(sprayTimes, 5 * 60_000)).toBeLessThan(10);
    expect(maxInWindow(sprayTimes, 10 * 60_000)).toBeGreaterThanOrEqual(10);

    const success = scenario('bruteforce-success');
    const successFailures = success.filter(isFailedSsh);
    expect(successFailures).toHaveLength(40);
    const times = successFailures.map((e) => Date.parse(e.ts));
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(3 * 60_000);
    const accepted = success.filter((e) => e.action === 'ssh_login' && e.outcome === 'success');
    expect(accepted.map((e) => [e.user, e.srcIp])).toEqual([['deploy', '203.0.113.77']]);
    expect(Date.parse(accepted[0]?.ts ?? '')).toBeGreaterThan(Math.max(...times));
  });

  it('shapes the account and web scenarios as the rules expect', () => {
    const scenario = (id: string) =>
      parsed.filter((p) => p.line.scenario === id).map((p) => p.event);

    const priv = scenario('privileged-user');
    const created = priv.find((e) => e.action === 'user_created');
    const added = priv.find((e) => e.action === 'user_added_to_group');
    expect(created?.user).toBe('backup2');
    expect(created?.message).toContain('GID=27,');
    expect(added?.fields['group.name']).toBe('sudo');
    expect(Date.parse(added?.ts ?? '') - Date.parse(created?.ts ?? '')).toBeLessThan(10 * 60_000);

    const sudo = scenario('sudo-not-allowed').filter((e) => e.action === 'sudo_not_in_sudoers');
    expect(sudo.map((e) => e.user)).toEqual(['intern', 'intern', 'intern']);

    const recon = scenario('web-recon');
    expect(recon.length).toBeGreaterThanOrEqual(550);
    const reconTimes = recon.map((e) => Date.parse(e.ts));
    expect(Math.max(...reconTimes) - Math.min(...reconTimes)).toBeLessThanOrEqual(3 * 60_000);
    const notFound = recon.filter((e) => e.fields['sc-status'] === 404).map((e) => Date.parse(e.ts));
    expect(notFound.length / recon.length).toBeGreaterThan(0.8);
    expect(maxInWindow(notFound, 2 * 60_000)).toBeGreaterThanOrEqual(50);

    const sqli = scenario('sqli');
    expect(sqli.every((e) => e.fields['sc-status'] !== 404)).toBe(true);
  });
});

describe('small sample through the pipeline and PostgreSQL', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  it('stores every line of every file', async () => {
    const { files } = generate({ seed: 7, days: 3, startMs: START_MS, small: true });
    const pipeline = createPipeline({ pool: db.pool });
    let total = 0;
    for (const file of files) {
      const summary = await pipeline.ingest(file.content.split('\n'), {
        source: file.source,
        host: file.host,
        receivedAt: RECEIVED_AT,
        timezone: 'UTC',
      });
      expect(summary.rejected, file.path).toBe(0);
      expect(summary.accepted, file.path).toBe(file.lineCount);
      total += file.lineCount;
    }
    const { rows } = await db.pool.query<{ count: string }>('SELECT count(*) FROM events');
    expect(Number(rows[0]?.count)).toBe(total);
    const hosts = await db.pool.query<{ host: string }>('SELECT DISTINCT host FROM events ORDER BY host');
    expect(hosts.rows.map((r) => r.host)).toEqual([
      'bastion-01',
      'db-01',
      'web-01',
      'web-02',
      'ws-0142',
      'ws-0187',
    ]);
  });
});
