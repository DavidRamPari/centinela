/**
 * Correlation semantics (ARCHITECTURE §6) with hand-built event streams: thresholds at
 * their boundaries, window expiry, group isolation, ordered and unordered temporal rules,
 * chaining, `generate`, late events and eviction.
 */
import type { NormalizedEvent } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { CorrelationState } from '../../src/detection/correlation/state.js';
import { createEngine } from '../../src/detection/engine.js';
import type { AlertCandidate } from '../../src/pipeline/types.js';
import { at, correlationRule, makeEvent, ruleSetFrom, sigmaRule } from './helpers.js';

const RULES = {
  'centinela/auth_failure.yml': sigmaRule({
    name: 'fail',
    detection: { s: { 'event.action': 'ssh_login', 'event.outcome': 'failure' }, condition: 's' },
  }),
  'centinela/auth_success.yml': sigmaRule({
    name: 'ok',
    detection: { s: { 'event.action': 'ssh_login', 'event.outcome': 'success' }, condition: 's' },
  }),
  'centinela/marker_a.yml': sigmaRule({
    name: 'a',
    detection: { s: { 'event.action': 'a' }, condition: 's' },
  }),
  'centinela/marker_b.yml': sigmaRule({
    name: 'b',
    detection: { s: { 'event.action': 'b' }, condition: 's' },
  }),
  'correlation/brute.yml': correlationRule({
    name: 'brute',
    correlation: {
      type: 'event_count',
      rules: ['fail'],
      'group-by': ['source.ip', 'host.name'],
      timespan: '5m',
      condition: { gte: 10 },
      generate: false,
    },
  }),
  'correlation/brute_gt.yml': correlationRule({
    name: 'brute-gt',
    correlation: {
      type: 'event_count',
      rules: ['fail'],
      'group-by': ['source.ip'],
      timespan: '5m',
      condition: { gt: 20 },
    },
  }),
  'correlation/spray.yml': correlationRule({
    name: 'spray',
    correlation: {
      type: 'value_count',
      rules: ['fail'],
      'group-by': ['source.ip'],
      timespan: '10m',
      condition: { gte: 10, field: 'user.name' },
      generate: false,
    },
  }),
  'correlation/success_after_brute.yml': correlationRule({
    name: 'brute-success',
    level: 'critical',
    correlation: {
      type: 'temporal_ordered',
      rules: ['brute', 'ok'],
      'group-by': ['source.ip'],
      timespan: '30m',
      generate: false,
    },
  }),
  'correlation/a_then_b.yml': correlationRule({
    name: 'a-then-b',
    correlation: {
      type: 'temporal_ordered',
      rules: ['a', 'b'],
      'group-by': ['user.name'],
      timespan: '10m',
      generate: true,
    },
  }),
  'correlation/a_and_b.yml': correlationRule({
    name: 'a-and-b',
    correlation: {
      type: 'temporal',
      rules: ['a', 'b'],
      'group-by': ['user.name'],
      timespan: '10m',
      generate: true,
    },
  }),
};

const ruleSet = ruleSetFrom(RULES);
const idOf = (name: string) => {
  const id = ruleSet.rules.find((r) => r.meta.name === name)?.meta.id;
  if (!id) throw new Error(`no rule ${name}`);
  return id;
};
const nameOf = new Map(ruleSet.rules.map((r) => [r.meta.id, r.meta.name]));

function run(events: NormalizedEvent[]) {
  const engine = createEngine(ruleSet);
  const candidates: AlertCandidate[] = events.flatMap((event) => engine.process(event));
  const last = events[events.length - 1];
  if (last) candidates.push(...engine.flush(new Date(last.ts)));
  const of = (name: string) => candidates.filter((c) => c.rule.id === idOf(name));
  return { candidates, of, names: candidates.map((c) => nameOf.get(c.rule.id)) };
}

const failed = (seconds: number, ip = '203.0.113.45', user = 'root', host = 'bastion-01') =>
  makeEvent({
    ts: at(seconds),
    srcIp: ip,
    user,
    host,
    fields: { 'event.action': 'ssh_login', 'event.outcome': 'failure' },
  });
const accepted = (seconds: number, ip = '203.0.113.45', user = 'deploy') =>
  makeEvent({
    ts: at(seconds),
    srcIp: ip,
    user,
    fields: { 'event.action': 'ssh_login', 'event.outcome': 'success' },
  });
const marker = (action: 'a' | 'b', seconds: number, user = 'ana') =>
  makeEvent({ ts: at(seconds), user, fields: { 'event.action': action } });

const range = (n: number, f: (i: number) => NormalizedEvent) =>
  Array.from({ length: n }, (_, i) => f(i));

describe('event_count', () => {
  it('does not fire at threshold − 1 and fires once at the threshold (gte)', () => {
    expect(run(range(9, (i) => failed(i))).of('brute')).toHaveLength(0);
    const { of } = run(range(10, (i) => failed(i)));
    expect(of('brute')).toHaveLength(1);
  });

  it('gt needs one more match than the threshold', () => {
    expect(run(range(20, (i) => failed(i))).of('brute-gt')).toHaveLength(0);
    expect(run(range(21, (i) => failed(i))).of('brute-gt')).toHaveLength(1);
  });

  it('links the contributing events oldest first and keys the alert by group', () => {
    const events = range(10, (i) => failed(i));
    const [candidate] = run(events).of('brute');
    expect(candidate).toMatchObject({
      groupKey: 'source.ip=203.0.113.45,host.name=bastion-01',
      dedupKey: `${idOf('brute')}|source.ip=203.0.113.45,host.name=bastion-01`,
      firstSeen: events[0]?.ts,
      lastSeen: events[9]?.ts,
      host: 'bastion-01',
      entities: { ips: ['203.0.113.45'], users: ['root'], hosts: ['bastion-01'] },
    });
    expect(candidate?.eventIds).toEqual(events.map((e) => e.id));
    expect(candidate?.rule).toMatchObject({
      type: 'correlation',
      level: 'high',
      techniques: ['T1110.001'],
    });
  });

  it('counts the window inclusively: [t − timespan, t]', () => {
    const inside = [...range(9, (i) => failed(i)), failed(300)];
    expect(run(inside).of('brute')).toHaveLength(1);
    const outside = [...range(9, (i) => failed(i)), failed(300.001)];
    expect(run(outside).of('brute')).toHaveLength(0);
  });

  it('forgets matches that leave the window', () => {
    const events = [...range(5, (i) => failed(i)), ...range(5, (i) => failed(400 + i))];
    expect(run(events).of('brute')).toHaveLength(0);
  });

  it('clears the window after firing, so the next alert needs a fresh window', () => {
    expect(run(range(19, (i) => failed(i))).of('brute')).toHaveLength(1);
    expect(run(range(20, (i) => failed(i))).of('brute')).toHaveLength(2);
  });

  it('keeps groups apart', () => {
    const twoIps = range(18, (i) => failed(i, i % 2 === 0 ? '203.0.113.45' : '203.0.113.46'));
    expect(run(twoIps).of('brute')).toHaveLength(0);
    const twoHosts = range(18, (i) =>
      failed(i, '203.0.113.45', 'root', i % 2 === 0 ? 'bastion-01' : 'bastion-02'),
    );
    expect(run(twoHosts).of('brute')).toHaveLength(0);
  });

  it('ignores events missing a group-by field', () => {
    const noIp = range(12, (i) =>
      makeEvent({
        ts: at(i),
        user: 'root',
        fields: { 'event.action': 'ssh_login', 'event.outcome': 'failure' },
      }),
    );
    expect(run(noIp).of('brute')).toHaveLength(0);
  });

  it('accepts events up to 60 s older than the group’s newest and ignores older ones', () => {
    const late = [...range(8, (i) => failed(100 + i)), failed(200), failed(141)];
    expect(run(late).of('brute')).toHaveLength(1);
    const tooLate = [...range(8, (i) => failed(100 + i)), failed(200), failed(139)];
    expect(run(tooLate).of('brute')).toHaveLength(0);
  });
});

describe('value_count', () => {
  it('counts distinct values of condition.field in the window', () => {
    expect(
      run(range(9, (i) => failed(i * 30, '198.51.100.23', `user${i}`))).of('spray'),
    ).toHaveLength(0);
    const { of } = run(range(10, (i) => failed(i * 30, '198.51.100.23', `user${i}`)));
    expect(of('spray')).toHaveLength(1);
    expect(of('spray')[0]?.entities.users).toHaveLength(10);
    expect(of('spray')[0]?.groupKey).toBe('source.ip=198.51.100.23');
  });

  it('does not count the same value twice', () => {
    const events = range(50, (i) => failed(i * 5, '198.51.100.23', i % 2 === 0 ? 'root' : 'admin'));
    expect(run(events).of('spray')).toHaveLength(0);
  });

  it('counts only values inside the window', () => {
    const events = range(10, (i) => failed(i * 70, '198.51.100.23', `user${i}`));
    expect(run(events).of('spray')).toHaveLength(0);
  });
});

describe('temporal and temporal_ordered', () => {
  it('temporal fires for every referenced rule in any order', () => {
    expect(run([marker('a', 0), marker('b', 60)]).of('a-and-b')).toHaveLength(1);
    expect(run([marker('b', 0), marker('a', 60)]).of('a-and-b')).toHaveLength(1);
  });

  it('temporal_ordered fires only in the listed order', () => {
    expect(run([marker('a', 0), marker('b', 60)]).of('a-then-b')).toHaveLength(1);
    expect(run([marker('b', 0), marker('a', 60)]).of('a-then-b')).toHaveLength(0);
  });

  it('temporal_ordered links the events of the sequence, not earlier noise', () => {
    const events = [marker('b', 0), marker('a', 30), marker('b', 60)];
    const [candidate] = run(events).of('a-then-b');
    expect(candidate?.eventIds).toEqual([events[1]?.id, events[2]?.id]);
  });

  it('both need every step within the timespan', () => {
    expect(run([marker('a', 0), marker('b', 601)]).of('a-then-b')).toHaveLength(0);
    expect(run([marker('a', 0), marker('b', 601)]).of('a-and-b')).toHaveLength(0);
    expect(run([marker('a', 0), marker('b', 600)]).of('a-then-b')).toHaveLength(1);
  });

  it('keep groups apart', () => {
    expect(run([marker('a', 0, 'ana'), marker('b', 60, 'bob')]).of('a-and-b')).toHaveLength(0);
  });
});

describe('chaining (centinela-ssh-bruteforce-success semantics)', () => {
  it('fires after a brute force and then a success from the same source', () => {
    const events = [...range(10, (i) => failed(i)), accepted(120)];
    const { of } = run(events);
    expect(of('brute')).toHaveLength(1);
    const [chained] = of('brute-success');
    expect(chained).toBeDefined();
    expect(chained?.rule.level).toBe('critical');
    expect(chained?.groupKey).toBe('source.ip=203.0.113.45');
    expect(chained?.eventIds).toEqual(events.map((e) => e.id));
  });

  it('does not fire after two failures and a success (a staff typo)', () => {
    const { names } = run([
      failed(0, '10.20.1.5', 'ana'),
      failed(5, '10.20.1.5', 'ana'),
      accepted(10, '10.20.1.5', 'ana'),
    ]);
    expect(names).toEqual([]);
  });

  it('does not fire for a success before the brute force, or from another source', () => {
    expect(
      run([accepted(0), ...range(10, (i) => failed(10 + i))]).of('brute-success'),
    ).toHaveLength(0);
    expect(
      run([...range(10, (i) => failed(i)), accepted(60, '203.0.113.99')]).of('brute-success'),
    ).toHaveLength(0);
  });

  it('does not fire when the success comes after the timespan', () => {
    expect(
      run([...range(10, (i) => failed(i)), accepted(9 + 1801)]).of('brute-success'),
    ).toHaveLength(0);
  });

  it('counts the inner firing at the time of its last event', () => {
    // Brute force ends at t=9 s; success at t=9+1800 s is exactly 30 minutes later.
    expect(
      run([...range(10, (i) => failed(i)), accepted(9 + 1800)]).of('brute-success'),
    ).toHaveLength(1);
  });
});

describe('generate (D-010)', () => {
  it('generate: false silences the referenced Sigma rules only', () => {
    const { names } = run([...range(10, (i) => failed(i)), accepted(120)]);
    expect(names).not.toContain('fail');
    expect(names).not.toContain('ok');
    expect(names).toContain('brute');
    expect(names).toContain('brute-success');
  });

  it('generate: true keeps the referenced Sigma rules alerting', () => {
    const { names } = run([marker('a', 0), marker('b', 60)]);
    // Sigma rules first (path order), then correlations in dependency and path order.
    expect(names).toEqual(['a', 'b', 'a-and-b', 'a-then-b']);
  });

  it('generate defaults to false', () => {
    // `fail` feeds brute and spray (generate: false) and brute-gt (no generate).
    expect(ruleSet.rules.find((r) => r.meta.name === 'fail')?.meta.buildingBlock).toBe(true);
    expect(ruleSet.rules.find((r) => r.meta.name === 'a')?.meta.buildingBlock).toBe(false);
  });
});

describe('state', () => {
  it('evicts a group once the watermark passes its newest match plus the timespan', () => {
    const correlation = ruleSet.correlations.find((c) => c.meta.name === 'brute');
    if (!correlation) throw new Error('missing');
    const state = new CorrelationState(correlation);
    const match = (time: number, ip: string) => ({
      ruleId: idOf('fail'),
      time,
      value: (field: string) => ({ 'source.ip': ip, 'host.name': 'h' })[field],
      events: [{ id: `e-${ip}-${time}`, ts: new Date(time).toISOString(), time, host: 'h' }],
    });
    state.add(match(0, '203.0.113.1'));
    state.add(match(200_000, '203.0.113.2'));
    expect(state.groupCount).toBe(2);
    state.evict(300_000);
    expect(state.groupCount).toBe(2);
    state.evict(300_001);
    expect(state.groupCount).toBe(1);
    state.evict(500_001);
    expect(state.groupCount).toBe(0);
  });

  it('the engine sweeps expired groups as event time advances and on flush', () => {
    const engine = createEngine(ruleSet);
    for (let i = 0; i < 5; i += 1) engine.process(failed(i));
    engine.flush(new Date(at(10_000)));
    // A fresh burst after the flush starts from an empty window.
    const candidates = range(9, (i) => failed(10_000 + i)).flatMap((e) => engine.process(e));
    expect(candidates.filter((c) => c.rule.id === idOf('brute'))).toHaveLength(0);
    expect(engine.watermark).toBe(Date.parse(at(10_008)));
  });
});
