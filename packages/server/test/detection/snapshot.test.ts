/**
 * The engine's detection time and its snapshot (ARCHITECTURE §6.2, §6.3): correlation
 * windows saved as plain data and restored into another engine.
 */
import type { NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { CorrelationState, MAX_ENTRIES_PER_GROUP } from '../../src/detection/correlation/state.js';
import { createEngine } from '../../src/detection/engine.js';
import { loadRuleSet } from '../../src/detection/index.js';
import { correlationFingerprint, type GroupSnapshot } from '../../src/detection/snapshot.js';
import { createParserRegistry } from '../../src/parsers/index.js';
import { RULES_DIR } from '../pipeline/live.js';

const ruleSet = loadRuleSet(RULES_DIR);
const parser = createParserRegistry().get('linux_auth');
const ATTACKER = '203.0.113.45';
const BRUTE_FORCE = 'SSH brute force from a single source';

let sequence = 0;
function failure(ts: string, user = 'root', ip = ATTACKER): NormalizedEvent {
  const result = parser?.parse(
    `${ts} bastion-01 sshd[4242]: Failed password for ${user} from ${ip} port 50022 ssh2`,
    {
      source: 'linux_auth',
      host: 'bastion-01',
      timezone: 'UTC',
      receivedAt: new Date('2026-10-26T00:00:00Z'),
    },
  );
  if (!result?.ok) throw new Error('test line was not parsed');
  sequence += 1;
  return {
    ...result.event,
    id: `00000000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`,
    ingestedAt: '2026-10-26T00:00:00.000Z',
  };
}
const at = (second: number) => `2026-10-25T11:00:${String(second).padStart(2, '0')}Z`;
const bruteForce = (rules: string[]) => rules.filter((title) => title === BRUTE_FORCE).length;

describe('detection time', () => {
  it('is the event time unless the pipeline passes another one', () => {
    const engine = createEngine(ruleSet);
    engine.process(failure(at(5)));
    expect(engine.watermark).toBe(Date.parse(at(5)));
    // An event that claims 2030, evaluated at the time it was received.
    const received = Date.parse(at(6));
    engine.process(failure('2030-01-01T00:00:00Z'), received);
    expect(engine.watermark).toBe(received);
  });

  it('dates a correlation alert by detection time, not by what the events claim', () => {
    const engine = createEngine(ruleSet);
    const candidates = Array.from({ length: 10 }, (_, i) =>
      engine.process(failure('2030-01-01T00:00:00Z'), Date.parse(at(i))),
    ).flat();
    const alert = candidates.find((candidate) => candidate.rule.title === BRUTE_FORCE);
    expect(alert).toMatchObject({
      firstSeen: '2026-10-25T11:00:00.000Z',
      lastSeen: '2026-10-25T11:00:09.000Z',
    });
    expect(alert?.eventIds).toHaveLength(10);
  });

  it('keeps the timestamp text of an event that was not clamped', () => {
    const engine = createEngine(ruleSet);
    const event = failure('2026-10-25T11:00:00.123456Z');
    const candidates = Array.from({ length: 10 }, () =>
      engine.process(event, Date.parse(event.ts)),
    ).flat();
    expect(candidates.find((c) => c.rule.title === BRUTE_FORCE)?.firstSeen).toBe(event.ts);
  });
});

describe('engine snapshot', () => {
  it('carries open windows into another engine: five failures before, five after', () => {
    const first = createEngine(ruleSet);
    for (let i = 0; i < 5; i += 1) expect(first.process(failure(at(i)))).toEqual([]);
    // Through JSON, as it travels through the database.
    const snapshot: unknown = JSON.parse(JSON.stringify(first.snapshot()));

    const second = createEngine(ruleSet);
    expect(second.restore(snapshot)).toEqual({ restored: 2, dropped: 0 });
    expect(second.watermark).toBe(Date.parse(at(4)));
    expect(second.snapshot()).toEqual(first.snapshot());
    const titles = Array.from({ length: 5 }, (_, i) => second.process(failure(at(i + 5))))
      .flat()
      .map((candidate) => candidate.rule.title);
    expect(bruteForce(titles)).toBe(1);

    // Without the snapshot the same five are not enough.
    const fresh = createEngine(ruleSet);
    const none = Array.from({ length: 5 }, (_, i) => fresh.process(failure(at(i + 5)))).flat();
    expect(none).toEqual([]);
  });

  it('gives the same candidates, with the same events, as an engine that never stopped', () => {
    const events = Array.from({ length: 24 }, (_, i) => failure(at(i), `user${i % 12}`));
    const whole = createEngine(ruleSet);
    const expected = events.flatMap((event) => whole.process(event));

    for (const stopAt of [1, 7, 9, 10, 15, 23]) {
      const before = createEngine(ruleSet);
      const got = events.slice(0, stopAt).flatMap((event) => before.process(event));
      const after = createEngine(ruleSet);
      after.restore(JSON.parse(JSON.stringify(before.snapshot())));
      got.push(...events.slice(stopAt).flatMap((event) => after.process(event)));
      expect(got).toEqual(expected);
    }
    expect(expected.map((c) => c.rule.title)).toContain(
      'SSH password spraying from a single source',
    );
  });

  it('holds only rules with open windows, and nothing once they fired', () => {
    const engine = createEngine(ruleSet);
    expect(engine.snapshot()).toEqual({ watermark: null, lastSweep: null, correlations: [] });
    engine.process(failure(at(0)));
    const open = engine.snapshot();
    expect(open.correlations).toHaveLength(2);
    expect(open.correlations.every((c) => /^[0-9a-f]{32}$/.test(c.fingerprint))).toBe(true);
    const bruteForceId = ruleSet.correlations.find((c) => c.meta.title === BRUTE_FORCE)?.meta.id;
    expect(open.correlations.map((c) => c.id)).toContain(bruteForceId);
    for (let i = 1; i < 10; i += 1) engine.process(failure(at(i)));
    // Brute force fired and cleared its window. Spraying (one user so far) is still
    // counting, and the firing opened a window in the rule that waits for a login after it.
    const afterFiring = engine.snapshot().correlations.map((c) => c.id);
    expect(afterFiring).toHaveLength(2);
    expect(afterFiring).not.toContain(bruteForceId);
  });

  it('drops state saved for a rule that changed or is gone, and keeps the rest', () => {
    const first = createEngine(ruleSet);
    for (let i = 0; i < 5; i += 1) first.process(failure(at(i), `user${i}`));
    const snapshot = first.snapshot();
    const [one, two] = snapshot.correlations;
    if (one === undefined || two === undefined) throw new Error('expected two open windows');
    const second = createEngine(ruleSet);
    expect(
      second.restore({
        ...snapshot,
        correlations: [
          { ...one, fingerprint: 'changed' },
          two,
          { id: 'deleted-rule', fingerprint: 'x', groups: [] },
        ],
      }),
    ).toEqual({ restored: 1, dropped: 2 });
    expect(second.snapshot().correlations.map((c) => c.id)).toEqual([two.id]);
  });

  it.each([
    ['null', null],
    ['text', 'state'],
    ['a watermark that is not a number', { watermark: 'now', lastSweep: null, correlations: [] }],
    [
      'matches without their events',
      {
        watermark: 1,
        lastSweep: null,
        correlations: [
          {
            id: 'x',
            fingerprint: 'y',
            groups: [{ values: [], newest: 1, seen: 1, entries: [{ ruleId: 'r', time: 1 }] }],
          },
        ],
      },
    ],
    [
      'a match at a time no date can hold',
      {
        watermark: 1,
        lastSweep: null,
        correlations: [
          {
            id: 'x',
            fingerprint: 'y',
            groups: [
              {
                values: [],
                newest: 1,
                seen: 1,
                entries: [{ ruleId: 'r', time: 1e300, events: [] }],
              },
            ],
          },
        ],
      },
    ],
    [
      'an event whose timestamp is not a date',
      {
        watermark: 1,
        lastSweep: null,
        correlations: [
          {
            id: 'x',
            fingerprint: 'y',
            groups: [
              {
                values: [],
                newest: 1,
                seen: 1,
                entries: [
                  {
                    ruleId: 'r',
                    time: 1,
                    events: [{ id: 'e', ts: 'the day after tomorrow', time: 1, host: 'h' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    ['a watermark no date can hold', { watermark: 9e15, lastSweep: null, correlations: [] }],
  ])('refuses a malformed snapshot (%s) and keeps its own state', (_, snapshot) => {
    const engine = createEngine(ruleSet);
    for (let i = 0; i < 9; i += 1) engine.process(failure(at(i)));
    expect(() => engine.restore(snapshot)).toThrow();
    const titles = engine.process(failure(at(9))).map((candidate) => candidate.rule.title);
    expect(bruteForce(titles)).toBe(1);
  });

  it('replaces the state it had: restoring an empty snapshot forgets open windows', () => {
    const engine = createEngine(ruleSet);
    for (let i = 0; i < 9; i += 1) engine.process(failure(at(i)));
    engine.restore({ watermark: null, lastSweep: null, correlations: [] });
    expect(engine.process(failure(at(9)))).toEqual([]);
    expect(engine.watermark).toBe(Date.parse(at(9)));
  });
});

describe('correlation fingerprint', () => {
  const [bruteforce, other] = ruleSet.correlations;
  if (bruteforce === undefined || other === undefined) throw new Error('rules not loaded');

  it('is stable for a rule and different between rules', () => {
    expect(correlationFingerprint(bruteforce)).toBe(correlationFingerprint({ ...bruteforce }));
    expect(new Set(ruleSet.correlations.map(correlationFingerprint)).size).toBe(
      ruleSet.correlations.length,
    );
  });

  it.each([
    ['the timespan', { timespanMs: bruteforce.timespanMs + 1 }],
    ['the group-by fields', { groupBy: [...bruteforce.groupBy, 'user.name'] }],
    ['the threshold', { gte: (bruteforce.gte ?? 0) + 1 }],
    ['the rules it counts', { refs: [...bruteforce.refs, 'another-rule'] }],
    ['the type', { type: 'temporal' as const }],
  ])('changes with %s', (_, change) => {
    expect(correlationFingerprint({ ...bruteforce, ...change })).not.toBe(
      correlationFingerprint(bruteforce),
    );
  });

  it('does not change with the title or the level', () => {
    const renamed = { ...bruteforce, meta: { ...bruteforce.meta, title: 'Another title' } };
    expect(correlationFingerprint(renamed)).toBe(correlationFingerprint(bruteforce));
  });
});

describe('CorrelationState.import', () => {
  const rule = ruleSet.correlations.find((c) => c.groupBy.length === 2 && c.type === 'event_count');
  if (rule === undefined) throw new Error('no event_count rule with two group-by fields');
  const entry = (time: number) => ({
    ruleId: rule.refs[0] ?? 'r',
    time,
    events: [{ id: `e${time}`, ts: new Date(time).toISOString(), time, host: 'h' }],
  });
  const group = (values: string[], times: number[]): GroupSnapshot => ({
    values,
    newest: Math.max(...times),
    seen: Math.max(...times),
    entries: times.map(entry),
  });

  it('round-trips through export', () => {
    const state = new CorrelationState(rule);
    const saved = [
      group(['203.0.113.1', 'web-01'], [10, 20, 30]),
      group(['203.0.113.2', 'web-01'], [5]),
    ];
    state.import(saved);
    expect(state.groupCount).toBe(2);
    expect(state.export()).toEqual(saved);
  });

  it('skips groups that do not fit the rule and sorts matches by time', () => {
    const state = new CorrelationState(rule);
    state.import([
      group(['only-one-value'], [1]),
      { values: ['a', 'b'], newest: 5, seen: 5, entries: [] },
      group(['203.0.113.1', 'web-01'], [30, 10, 20]),
    ]);
    expect(state.export()).toEqual([group(['203.0.113.1', 'web-01'], [10, 20, 30])]);
  });

  it('keeps when a late group last took a match, and never before its newest match', () => {
    const state = new CorrelationState(rule);
    const late = { ...group(['203.0.113.1', 'web-01'], [10, 20]), seen: 900_000 };
    state.import([late, { ...group(['203.0.113.2', 'web-01'], [10, 20]), seen: 0 }]);
    expect(state.export().map((g) => g.seen)).toEqual([900_000, 20]);
    // Eviction counts from `seen`: the second group is a timespan old, the late one is not.
    state.evict(20 + rule.timespanMs + 1);
    expect(state.export()).toEqual([late]);
  });

  it('keeps the bound on matches per group whatever the snapshot holds', () => {
    const state = new CorrelationState(rule);
    const times = Array.from({ length: MAX_ENTRIES_PER_GROUP + 50 }, (_, i) => i + 1);
    state.import([group(['203.0.113.1', 'web-01'], times)]);
    const [kept] = state.export();
    expect(kept?.entries).toHaveLength(MAX_ENTRIES_PER_GROUP);
    expect(kept?.entries[0]?.time).toBe(51);
  });
});
