/**
 * The repository's rules through the real loader: SigmaHQ compile rate and attribution,
 * the golden test over SigmaHQ's regression samples, Centinela's own rules exactly as
 * ARCHITECTURE §6.1 specifies, and the prefilter against exhaustive evaluation.
 */
import { join } from 'node:path';
import { ruleMetaSchema } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { linuxWebEvents, windowsEvents } from '../../src/detection/bench.js';
import { createEngine } from '../../src/detection/engine.js';
import { loadRuleSet } from '../../src/detection/index.js';
import {
  evaluateRegression,
  readRegressionSamples,
  summarizeRegressionFiles,
} from '../../src/detection/regression.js';
import { buildRulesReport, sigmaHqCompileRate } from '../../src/detection/report.js';
import { readSigmaCommit } from '../../src/detection/rules/loader.js';
import { repoRoot } from '../../src/paths.js';

const rulesDir = join(repoRoot, 'rules');
const ruleSet = loadRuleSet(rulesDir);
const commit = readSigmaCommit(rulesDir);
const byName = (name: string) => ruleSet.rules.find((r) => r.meta.name === name)?.meta;

describe('vendored SigmaHQ rules', () => {
  it('at least 99% compile', () => {
    const { supported, total } = sigmaHqCompileRate(ruleSet);
    expect(total).toBeGreaterThanOrEqual(1231);
    expect(supported / total).toBeGreaterThanOrEqual(0.99);
  });

  it('carry author, rule link and DRL 1.1 license', () => {
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    for (const { meta } of ruleSet.rules.filter((r) => r.meta.origin === 'sigmahq')) {
      expect(meta.license, meta.path).toBe('DRL-1.1');
      expect(meta.author, meta.path).toBeTruthy();
      expect(meta.url, meta.path).toBe(
        `https://github.com/SigmaHQ/sigma/blob/${commit ?? ''}/rules/${meta.path.replace('rules/sigma/', '')}`,
      );
    }
  });

  it('produce metadata that satisfies the shared schema', () => {
    for (const { meta } of ruleSet.rules) ruleMetaSchema.parse(meta);
  });

  it('every skipped rule appears in the report with its reason', () => {
    const report = buildRulesReport({
      ruleSet,
      sigmaCommit: commit,
      regression: [],
      regressionFiles: [],
    });
    for (const { meta } of ruleSet.rules.filter((r) => !r.meta.supported)) {
      expect(report).toContain(meta.path);
      expect(report).toContain(meta.unsupportedReason ?? '');
    }
    for (const error of ruleSet.errors) expect(report).toContain(error.path);
  });
});

describe('golden: SigmaHQ regression samples (Event.EventData as the field view)', () => {
  const results = evaluateRegression(ruleSet, rulesDir);
  const files = summarizeRegressionFiles(results, rulesDir);

  it('reads every sample file, including those holding several objects', () => {
    expect(files).toHaveLength(267);
    expect(results.length).toBeGreaterThan(files.length);
    expect(files.filter((f) => f.events > 1).length).toBeGreaterThanOrEqual(5);
  });

  it('at least 95% of events match their rule', () => {
    const passed = results.filter((r) => r.passed).length;
    expect(passed / results.length).toBeGreaterThanOrEqual(0.95);
  });

  it('every file has at least the matches its info.yml expects', () => {
    expect(files.filter((f) => !f.passed).map((f) => f.path)).toEqual([]);
  });

  it('explains each miss', () => {
    for (const failure of results.filter((r) => !r.passed)) {
      expect(failure.reason).toMatch(/^(condition false|rule )/);
    }
  });
});

describe("Centinela's rules (ARCHITECTURE §6.1)", () => {
  const base: Array<[string, Record<string, string>, string, boolean]> = [
    ['centinela-ssh-auth-failure', { product: 'linux', service: 'sshd' }, 'low', true],
    ['centinela-ssh-auth-success', { product: 'linux', service: 'sshd' }, 'informational', true],
    ['centinela-sudo-auth-failure', { product: 'linux', service: 'sudo' }, 'low', false],
    ['centinela-sudo-user-not-in-sudoers', { product: 'linux', service: 'sudo' }, 'medium', false],
    ['centinela-user-created', { product: 'linux', service: 'auth' }, 'low', false],
    [
      'centinela-user-added-to-privileged-group',
      { product: 'linux', service: 'auth' },
      'medium',
      false,
    ],
    ['centinela-web-not-found', { category: 'webserver' }, 'informational', true],
  ];

  it.each(base)(
    '%s: logsource, level and building-block status',
    (name, logsource, level, buildingBlock) => {
      const meta = byName(name);
      expect(meta).toMatchObject({
        type: 'sigma',
        logsource,
        level,
        buildingBlock,
        supported: true,
        author: 'DavidRamPari',
        license: 'MIT',
        origin: 'centinela',
      });
      expect(meta?.techniques.length).toBeGreaterThan(0);
      expect(meta?.description).toBeTruthy();
      expect(meta?.falsepositives.length).toBeGreaterThan(0);
    },
  );

  const correlations: Array<
    [
      string,
      string,
      string[],
      string[],
      number,
      number | null,
      string | null,
      boolean,
      string,
      string[],
    ]
  > = [
    [
      'centinela-ssh-bruteforce',
      'event_count',
      ['centinela-ssh-auth-failure'],
      ['source.ip', 'host.name'],
      5,
      10,
      null,
      false,
      'high',
      ['T1110.001'],
    ],
    [
      'centinela-ssh-password-spraying',
      'value_count',
      ['centinela-ssh-auth-failure'],
      ['source.ip'],
      10,
      10,
      'user.name',
      false,
      'high',
      ['T1110.003'],
    ],
    [
      'centinela-ssh-bruteforce-success',
      'temporal_ordered',
      ['centinela-ssh-bruteforce', 'centinela-ssh-auth-success'],
      ['source.ip'],
      30,
      null,
      null,
      false,
      'critical',
      ['T1110.001', 'T1078'],
    ],
    [
      'centinela-privileged-account-created',
      'temporal_ordered',
      ['centinela-user-created', 'centinela-user-added-to-privileged-group'],
      ['user.name', 'host.name'],
      10,
      null,
      null,
      true,
      'high',
      ['T1136.001', 'T1098'],
    ],
    [
      'centinela-web-scanning-burst',
      'event_count',
      ['centinela-web-not-found'],
      ['source.ip', 'host.name'],
      2,
      50,
      null,
      false,
      'medium',
      ['T1595.002'],
    ],
  ];

  it.each(correlations)(
    '%s: %s over %j',
    (name, type, rules, groupBy, minutes, gte, field, generate, level, techniques) => {
      const compiled = ruleSet.correlations.find((c) => c.meta.name === name);
      expect(compiled).toBeDefined();
      expect(compiled?.refs.map((id) => ruleSet.rule(id)?.meta.name)).toEqual(rules);
      expect(compiled).toMatchObject({
        type,
        groupBy,
        timespanMs: minutes * 60_000,
        gte,
        gt: null,
        valueField: field,
        generate,
      });
      expect(compiled?.meta).toMatchObject({
        level,
        techniques,
        author: 'DavidRamPari',
        license: 'MIT',
      });
    },
  );

  it('the brute-force correlation keeps the id given in ARCHITECTURE §6', () => {
    expect(byName('centinela-ssh-bruteforce')?.id).toBe('6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e6f');
  });
});

describe('prefilter', () => {
  const samples = readRegressionSamples(rulesDir);
  it.each([
    ['linux/web mix', () => linuxWebEvents(3000)],
    ['windows mix', () => windowsEvents(3000, samples)],
  ])('gives the same candidates as exhaustive evaluation on the %s', (_name, build) => {
    const events = build();
    const fast = createEngine(ruleSet);
    const exhaustive = createEngine(ruleSet, { prefilter: false });
    const a = events.flatMap((e) => fast.process(e));
    const b = events.flatMap((e) => exhaustive.process(e));
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
});
