import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ruleMetaSchema } from '@centinela/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { loadRuleSet } from '../../src/detection/index.js';
import { listRuleFiles, readSigmaCommit } from '../../src/detection/rules/loader.js';
import { correlationRule, ruleSetFrom, sigmaRule, TEST_COMMIT } from './helpers.js';

const failure = (name: string, extra: Record<string, unknown> = {}) =>
  sigmaRule({
    name,
    detection: {
      selection: { 'event.action': 'ssh_login', 'event.outcome': 'failure' },
      condition: 'selection',
    },
    ...extra,
  });

describe('RuleMeta extraction (ARCHITECTURE §3.3)', () => {
  const sigmaId = '0ac15ec3-d24f-4246-aa2a-3077bb1cf90e';
  const ruleSet = ruleSetFrom({
    'sigma/linux/builtin/lnx_test.yml': `title: Privileged User Has Been Created
id: ${sigmaId}
status: test
description: Detects the addition of a new user to a privileged group
references:
    - https://example.org/a
author: Pawel Mazur
date: 2022-12-21
modified: 2025-01-21
tags:
    - attack.privilege-escalation
    - attack.t1136.001
    - attack.T1098
logsource:
    product: linux
    definition: 'auth.log needs to be collected'
detection:
    selection: ['new user']
    condition: selection
falsepositives:
    - Administrative activity
level: high
`,
    'centinela/linux/own.yml': failure('centinela-test-failure', { author: 'DavidRamPari' }),
  });
  const sigma = ruleSet.rule(sigmaId)?.meta;
  const own = ruleSet.rules.find((r) => r.meta.name === 'centinela-test-failure')?.meta;

  it('carries the SigmaHQ attribution DRL 1.1 requires', () => {
    expect(sigma).toMatchObject({
      author: 'Pawel Mazur',
      license: 'DRL-1.1',
      origin: 'sigmahq',
      path: 'rules/sigma/linux/builtin/lnx_test.yml',
      url: `https://github.com/SigmaHQ/sigma/blob/${TEST_COMMIT}/rules/linux/builtin/lnx_test.yml`,
    });
  });

  it('copies the descriptive fields and drops the logsource definition', () => {
    expect(sigma).toMatchObject({
      title: 'Privileged User Has Been Created',
      type: 'sigma',
      level: 'high',
      status: 'test',
      date: '2022-12-21',
      modified: '2025-01-21',
      references: ['https://example.org/a'],
      falsepositives: ['Administrative activity'],
      logsource: { product: 'linux' },
      supported: true,
      unsupportedReason: null,
      buildingBlock: false,
      enabled: true,
    });
  });

  it('upper-cases techniques and derives tactics from the ATT&CK data', () => {
    expect(sigma?.techniques).toEqual(['T1136.001', 'T1098']);
    expect(sigma?.tactics).toEqual(expect.arrayContaining(['persistence', 'privilege-escalation']));
  });

  it('marks Centinela’s own rules MIT without a SigmaHQ link', () => {
    expect(own).toMatchObject({
      license: 'MIT',
      origin: 'centinela',
      url: null,
      author: 'DavidRamPari',
    });
    expect(own?.tactics).toEqual(['credential-access']);
  });

  it('produces metadata that satisfies the shared schema', () => {
    for (const { meta } of ruleSet.rules) ruleMetaSchema.parse(meta);
  });

  it('keeps the YAML source for the rule detail endpoint', () => {
    expect(ruleSet.rule(sigmaId)?.source).toContain('title: Privileged User Has Been Created');
  });

  it('finds rules by id case-insensitively', () => {
    expect(ruleSet.rule(sigmaId.toUpperCase())?.meta.id).toBe(sigmaId);
  });
});

describe('load errors and unsupported rules', () => {
  const ruleSet = ruleSetFrom({
    'centinela/a_invalid_yaml.yml': 'title: [unclosed',
    'centinela/b_duplicate_key.yml': 'title: a\ntitle: b\n',
    'centinela/c_no_title.yml': 'id: 4a1e2d3c-1111-4222-8333-444455556666\nlevel: low\n',
    'centinela/d_bad_id.yml': 'title: x\nid: not-a-guid\nlevel: low\n',
    'centinela/e_no_level.yml': 'title: x\nid: 4a1e2d3c-1111-4222-8333-444455556667\n',
    'centinela/f_first.yml': failure('first', { id: '4a1e2d3c-1111-4222-8333-444455556668' }),
    'centinela/g_same_id.yml': failure('second', { id: '4a1e2d3c-1111-4222-8333-444455556668' }),
    'centinela/h_deprecated.yml': failure('deprecated', { status: 'deprecated' }),
    'centinela/i_multi.yml': `${failure('multi')}---\ntitle: second document\n`,
    'centinela/j_no_detection.yml':
      'title: x\nid: 4a1e2d3c-1111-4222-8333-444455556669\nlevel: low\nlogsource: {product: linux}\n',
    'centinela/k_no_logsource.yml':
      'title: x\nid: 4a1e2d3c-1111-4222-8333-44445555666a\nlevel: low\ndetection: {s: {a: 1}, condition: s}\n',
    'centinela/l_expand.yml': sigmaRule({
      name: 'expand',
      detection: { s: { 'a|expand': '%x%' }, condition: 's' },
    }),
    'centinela/m_same_name.yml': failure('first'),
  });
  const byPath = (path: string) =>
    ruleSet.rules.find((r) => r.meta.path === `rules/centinela/${path}`)?.meta;
  const errorOf = (path: string) =>
    ruleSet.errors.find((e) => e.path === `rules/centinela/${path}`)?.reason;

  it('reports files that are not rules as load errors', () => {
    expect(errorOf('a_invalid_yaml.yml')).toMatch(/^yaml:invalid/);
    expect(errorOf('b_duplicate_key.yml')).toMatch(/^yaml:duplicate-key/);
    expect(errorOf('c_no_title.yml')).toMatch(/^schema \(title/);
    expect(errorOf('d_bad_id.yml')).toMatch(/^schema \(id/);
    expect(errorOf('e_no_level.yml')).toMatch(/^schema \(level/);
    expect(errorOf('g_same_id.yml')).toMatch(/^rule:duplicate-id/);
    expect(byPath('f_first.yml')?.supported).toBe(true);
  });

  it('keeps valid rules with unsupported constructs, with a machine-readable reason', () => {
    expect(byPath('h_deprecated.yml')?.unsupportedReason).toBe('status:deprecated');
    expect(byPath('i_multi.yml')?.unsupportedReason).toBe('yaml:multi-document');
    expect(byPath('j_no_detection.yml')?.unsupportedReason).toBe('rule:missing-detection');
    expect(byPath('k_no_logsource.yml')?.unsupportedReason).toBe('rule:missing-logsource');
    expect(byPath('l_expand.yml')?.unsupportedReason).toBe('modifier:expand');
    expect(byPath('m_same_name.yml')?.unsupportedReason).toMatch(/^rule:duplicate-name/);
    for (const path of ['h_deprecated.yml', 'l_expand.yml'])
      expect(byPath(path)?.supported).toBe(false);
  });

  it('compiles only supported rules', () => {
    expect(ruleSet.sigma.map((r) => r.meta.name)).toEqual(['first']);
  });
});

describe('correlation rules', () => {
  const base = {
    'centinela/fail.yml': failure('fail'),
    'centinela/ok.yml': sigmaRule({
      name: 'ok',
      detection: { s: { 'event.action': 'ssh_login', 'event.outcome': 'success' }, condition: 's' },
    }),
  };
  const counting = (name: string, extra: Record<string, unknown> = {}) =>
    correlationRule({
      name,
      correlation: {
        type: 'event_count',
        rules: ['fail'],
        'group-by': ['source.ip', 'host.name'],
        timespan: '5m',
        condition: { gte: 10 },
        ...extra,
      },
    });

  it('resolve references by name or id and order inner rules first', () => {
    const okId = '9b0e8c1a-2222-4333-8444-555566667777';
    const ruleSet = ruleSetFrom({
      ...base,
      'centinela/ok.yml': sigmaRule({
        id: okId,
        name: 'ok',
        detection: { s: { 'event.action': 'ssh_login' }, condition: 's' },
      }),
      'correlation/a_outer.yml': correlationRule({
        name: 'outer',
        correlation: {
          type: 'temporal_ordered',
          rules: ['inner', okId],
          'group-by': ['source.ip'],
          timespan: '30m',
        },
      }),
      'correlation/b_inner.yml': counting('inner'),
    });
    expect(ruleSet.correlations.map((c) => c.meta.name)).toEqual(['inner', 'outer']);
    const outer = ruleSet.correlations[1];
    expect(outer?.refs).toEqual([ruleSet.correlations[0]?.meta.id, okId]);
  });

  it('accept timeframe as an alias of timespan', () => {
    const ruleSet = ruleSetFrom({
      ...base,
      'correlation/c.yml': counting('c', { timespan: undefined, timeframe: '2m' }),
    });
    expect(ruleSet.correlations[0]?.timespanMs).toBe(120_000);
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['unknown reference', { rules: ['nope'] }, 'correlation:unknown-reference'],
    ['unsupported type', { type: 'value_sum' }, 'correlation:type'],
    ['lt condition', { condition: { lt: 3 } }, 'correlation:condition'],
    ['eq condition', { condition: { eq: 3 } }, 'correlation:condition'],
    ['no threshold', { condition: {} }, 'correlation:condition'],
    [
      'value_count without field',
      { type: 'value_count', condition: { gte: 3 } },
      'correlation:condition',
    ],
    [
      'temporal with a condition',
      { type: 'temporal', rules: ['fail', 'ok'], condition: { gte: 2 } },
      'correlation:condition',
    ],
    ['bad timespan', { timespan: '5 minutes' }, 'correlation:timespan'],
    ['zero timespan', { timespan: '0m' }, 'correlation:timespan'],
    ['aliases', { aliases: { ip: { fail: 'source.ip' } } }, 'correlation:aliases'],
    ['missing rules', { rules: [] }, 'correlation:invalid'],
  ];
  it.each(cases)('are unsupported with %s', (_label, extra, reason) => {
    const ruleSet = ruleSetFrom({ ...base, 'correlation/x.yml': counting('x', extra) });
    const meta = ruleSet.rules.find((r) => r.meta.name === 'x')?.meta;
    expect(meta?.supported).toBe(false);
    expect(meta?.unsupportedReason).toMatch(new RegExp(`^${reason}`));
  });

  it('are unsupported when they reference an unsupported rule', () => {
    const ruleSet = ruleSetFrom({
      'centinela/fail.yml': failure('fail', { status: 'deprecated' }),
      'correlation/x.yml': counting('x'),
    });
    expect(ruleSet.rules.find((r) => r.meta.name === 'x')?.meta.unsupportedReason).toBe(
      'correlation:unsupported-reference (fail)',
    );
  });

  it('are unsupported in a cycle', () => {
    const ruleSet = ruleSetFrom({
      ...base,
      'correlation/a.yml': correlationRule({
        name: 'a',
        correlation: { type: 'event_count', rules: ['b'], timespan: '5m', condition: { gte: 2 } },
      }),
      'correlation/b.yml': correlationRule({
        name: 'b',
        correlation: { type: 'event_count', rules: ['a'], timespan: '5m', condition: { gte: 2 } },
      }),
      'correlation/c.yml': correlationRule({
        name: 'c',
        correlation: { type: 'event_count', rules: ['c'], timespan: '5m', condition: { gte: 2 } },
      }),
    });
    for (const name of ['a', 'b', 'c']) {
      expect(ruleSet.rules.find((r) => r.meta.name === name)?.meta.unsupportedReason, name).toMatch(
        /^correlation:cycle/,
      );
    }
  });

  it('require the inner group-by to contain the outer one when chaining', () => {
    const ruleSet = ruleSetFrom({
      ...base,
      'correlation/inner.yml': counting('inner', { 'group-by': ['host.name'] }),
      'correlation/outer.yml': correlationRule({
        name: 'outer',
        correlation: {
          type: 'temporal_ordered',
          rules: ['inner', 'ok'],
          'group-by': ['source.ip'],
          timespan: '30m',
        },
      }),
    });
    expect(ruleSet.rules.find((r) => r.meta.name === 'outer')?.meta.unsupportedReason).toMatch(
      /^correlation:group-by/,
    );
  });
});

describe('building blocks (ARCHITECTURE §6, D-010)', () => {
  const ruleSet = ruleSetFrom({
    'centinela/a_silenced.yml': failure('silenced'),
    'centinela/b_mixed.yml': failure('mixed'),
    'centinela/c_alone.yml': failure('alone'),
    'correlation/x.yml': correlationRule({
      name: 'x',
      correlation: {
        type: 'event_count',
        rules: ['silenced', 'mixed'],
        timespan: '5m',
        condition: { gte: 2 },
        generate: false,
      },
    }),
    'correlation/y.yml': correlationRule({
      name: 'y',
      correlation: {
        type: 'event_count',
        rules: ['mixed'],
        timespan: '5m',
        condition: { gte: 2 },
        generate: true,
      },
    }),
    'correlation/z.yml': correlationRule({
      name: 'z',
      correlation: {
        type: 'event_count',
        rules: ['x'],
        timespan: '5m',
        condition: { gte: 2 },
        generate: false,
      },
    }),
  });
  const meta = (name: string) => ruleSet.rules.find((r) => r.meta.name === name)?.meta;

  it('a Sigma rule referenced only by generate: false correlations is a building block', () => {
    expect(meta('silenced')?.buildingBlock).toBe(true);
  });

  it('a Sigma rule referenced by any generate: true correlation is not', () => {
    expect(meta('mixed')?.buildingBlock).toBe(false);
    expect(meta('alone')?.buildingBlock).toBe(false);
  });

  it('a referenced correlation never becomes a building block', () => {
    expect(meta('x')?.buildingBlock).toBe(false);
  });
});

describe('reading the rules folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'centinela-rules-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sigma', 'linux'), { recursive: true });
  mkdirSync(join(root, 'sigma', 'regression', 'windows'), { recursive: true });
  mkdirSync(join(root, 'centinela', 'web'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  writeFileSync(join(root, 'sigma', 'README.md'), `- Source commit: ${TEST_COMMIT} (2026-10-21)\n`);
  writeFileSync(join(root, 'sigma', 'linux', 'b.yml'), failure('b'));
  writeFileSync(join(root, 'sigma', 'linux', 'a.yaml'), failure('a'));
  writeFileSync(join(root, 'sigma', 'linux', 'notes.txt'), 'not a rule');
  writeFileSync(join(root, 'sigma', 'regression', 'windows', 'r.yml'), failure('regression'));
  writeFileSync(join(root, 'centinela', 'web', 'c.yml'), failure('c'));
  writeFileSync(join(root, 'elsewhere', 'd.yml'), failure('d'));
  writeFileSync(join(root, 'centinela', 'huge.yml'), `title: x\n#${'x'.repeat(1024 * 1024)}\n`);
  symlinkSync(join(root, 'elsewhere', 'd.yml'), join(root, 'centinela', 'link.yml'));

  it('lists sigma/, centinela/ and correlation/ only, without regression samples or links', () => {
    expect(listRuleFiles(root)).toEqual([
      'centinela/huge.yml',
      'centinela/web/c.yml',
      'sigma/linux/a.yaml',
      'sigma/linux/b.yml',
    ]);
  });

  it('reads the SigmaHQ commit from sigma/README.md', () => {
    expect(readSigmaCommit(root)).toBe(TEST_COMMIT);
    expect(readSigmaCommit(join(root, 'elsewhere'))).toBeNull();
  });

  it('loads, reports oversized files and memoizes per folder', () => {
    const ruleSet = loadRuleSet(root);
    expect(ruleSet.rules.map((r) => r.meta.name)).toEqual(['c', 'a', 'b']);
    expect(ruleSet.errors).toEqual([
      { path: 'rules/centinela/huge.yml', reason: 'file:too-large' },
    ]);
    expect(ruleSet.rules.find((r) => r.meta.name === 'a')?.meta.url).toBe(
      `https://github.com/SigmaHQ/sigma/blob/${TEST_COMMIT}/rules/linux/a.yaml`,
    );
    expect(loadRuleSet(root)).toBe(ruleSet);
  });

  it('fails clearly when the folder does not exist', () => {
    expect(() => loadRuleSet(join(root, 'missing'))).toThrow();
  });
});
