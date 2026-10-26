/** Builders shared by the detection tests: rules from objects, events, compiled detections. */
import type { FieldValue, LogSource, NormalizedEvent } from '@centinela/shared';
import { loadAttackIndexSync } from '@centinela/shared/node';
import { expect } from 'vitest';
import { stringify } from 'yaml';
import { EventView } from '../../src/detection/event-view.js';
import { buildRuleSet, type RuleSet } from '../../src/detection/rules/ruleset.js';
import { compileDetection, createCompileCache } from '../../src/detection/sigma/compile.js';

export const TEST_COMMIT = '05d1031f537e830b76da53bae2400c5814c89165';
export const attack = loadAttackIndexSync();

export interface MatchInput {
  fields?: Record<string, FieldValue>;
  message?: string;
}

/**
 * Evaluate a detection block against one event, compiled both on its own and with a
 * rule-set cache (memoization, literal index); both paths must agree.
 */
export function matches(detection: Record<string, unknown>, input: MatchInput): boolean {
  const event = { message: input.message ?? '', fields: input.fields ?? {} };
  const plain = compileDetection(detection).matches(new EventView(event));
  const cache = createCompileCache();
  const cached = compileDetection(detection, cache).matches(new EventView(event, cache.slots));
  expect(cached, 'cached and uncached compilation agree').toBe(plain);
  return plain;
}

/** `selection: {key: value}` with `condition: selection`. */
export function fieldMatches(key: string, value: unknown, input: MatchInput): boolean {
  return matches({ selection: { [key]: value }, condition: 'selection' }, input);
}

/** A rule set from in-memory files (`relPath` below `rules/` → YAML text). */
export function ruleSetFrom(files: Record<string, string>): RuleSet {
  const sources = Object.entries(files)
    .map(([relPath, text]) => ({ relPath, text }))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return buildRuleSet(sources, { sigmaCommit: TEST_COMMIT, attack });
}

let idCounter = 0;

/** A UUID-shaped id that is unique within the test run. */
export function testId(prefix = '0f6c3f5e'): string {
  idCounter += 1;
  return `${prefix}-1d2b-4c3a-9e8f-${idCounter.toString(16).padStart(12, '0')}`;
}

export interface SigmaRuleSpec {
  id?: string;
  name?: string;
  title?: string;
  status?: string;
  level?: string;
  author?: string;
  tags?: string[];
  logsource?: LogSource;
  detection: Record<string, unknown>;
}

export function sigmaRule(spec: SigmaRuleSpec): string {
  return stringify({
    title: spec.title ?? `Test rule ${spec.name ?? ''}`.trim(),
    id: spec.id ?? testId(),
    ...(spec.name !== undefined && { name: spec.name }),
    status: spec.status ?? 'test',
    author: spec.author ?? 'Test Author',
    tags: spec.tags ?? ['attack.credential-access', 'attack.t1110'],
    logsource: spec.logsource ?? { product: 'linux', service: 'sshd' },
    detection: spec.detection,
    level: spec.level ?? 'low',
  });
}

export interface CorrelationSpec {
  id?: string;
  name: string;
  level?: string;
  tags?: string[];
  correlation: Record<string, unknown>;
}

export function correlationRule(spec: CorrelationSpec): string {
  return stringify({
    title: `Correlation ${spec.name}`,
    id: spec.id ?? testId('6c1f0b6e'),
    name: spec.name,
    status: 'experimental',
    author: 'DavidRamPari',
    correlation: spec.correlation,
    level: spec.level ?? 'high',
    tags: spec.tags ?? ['attack.credential-access', 'attack.t1110.001'],
  });
}

let eventCounter = 0;

export interface EventSpec {
  ts: string;
  fields?: Record<string, FieldValue>;
  host?: string;
  srcIp?: string;
  user?: string;
  message?: string;
  logsources?: LogSource[];
}

/** A normalized event; `fields` gets the ECS base keys from `host`, `srcIp` and `user`. */
export function makeEvent(spec: EventSpec): NormalizedEvent {
  eventCounter += 1;
  const host = spec.host ?? 'bastion-01';
  return {
    id: `01930f6e-8a4b-7c2d-9e1f-${eventCounter.toString(16).padStart(12, '0')}`,
    ts: new Date(spec.ts).toISOString(),
    ingestedAt: '2026-10-26T00:00:00.000Z',
    source: 'linux_auth',
    host,
    logsources: spec.logsources ?? [
      { product: 'linux', service: 'sshd' },
      { product: 'linux', service: 'auth' },
    ],
    category: 'authentication',
    action: 'ssh_login',
    outcome: 'failure',
    ...(spec.user !== undefined && { user: spec.user }),
    ...(spec.srcIp !== undefined && { srcIp: spec.srcIp }),
    message: spec.message ?? '',
    fields: {
      'host.name': host,
      ...(spec.user !== undefined && { 'user.name': spec.user }),
      ...(spec.srcIp !== undefined && { 'source.ip': spec.srcIp }),
      ...spec.fields,
    },
  };
}

/** `2026-10-21T03:00:00Z` plus `seconds`. */
export function at(seconds: number): string {
  return new Date(Date.parse('2026-10-21T03:00:00Z') + seconds * 1000).toISOString();
}
