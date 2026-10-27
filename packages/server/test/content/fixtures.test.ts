/**
 * Content-pack regression suite (session S7). Every fixture of a content folder that is
 * not listed in its failures file must pass against its rule with the current engine:
 * positives match, negatives do not. Listed failures are skipped, so the suite uses only
 * the fixtures that pass; a listed failure that starts passing (an engine fix, a repaired
 * fixture) makes the list stale, and `npm run content:validate` refreshes it.
 *
 * `content/sigma` (SigmaHQ rules) is always checked. `content/centinela` (Centinela's own
 * rules; correlations have a playbook only) is checked once it has been generated.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  failureKeys,
  failuresFileSchema,
  fixtureKey,
  type FailuresFile,
} from '../../src/content/failures.js';
import { loadRuleFolder } from '../../src/content/rules.js';
import {
  readContentDir,
  validateContent,
  type ContentValidation,
} from '../../src/content/validate.js';
import { repoRoot } from '../../src/paths.js';

const PACKS = [
  { name: 'sigma', rules: join('rules', 'sigma'), minFixtures: 4_000 },
  { name: 'centinela', rules: 'rules', minFixtures: 1 },
] as const;

describe.each(PACKS)('content/$name fixtures (regression)', ({ name, rules, minFixtures }) => {
  const contentDir = join(repoRoot, 'content', name);
  const failuresFile = `content/${name}-failures.json`;
  const refresh = `run \`npm run content:validate -- --content content/${name}\` and commit ${failuresFile}`;
  const present = existsSync(contentDir);
  let validation: ContentValidation;
  let baseline: FailuresFile;
  let elapsedMs = 0;

  beforeAll(() => {
    if (!present) return;
    const started = performance.now();
    validation = validateContent(loadRuleFolder(join(repoRoot, rules)), readContentDir(contentDir));
    elapsedMs = performance.now() - started;
    baseline = failuresFileSchema.parse(
      JSON.parse(readFileSync(join(repoRoot, failuresFile), 'utf8')) as unknown,
    );
  }, 30_000);

  it.skipIf(!present)('every content file is valid and belongs to a rule', () => {
    expect(validation.malformed).toEqual([]);
    expect(validation.orphans).toEqual([]);
    expect(
      validation.evaluated.length + validation.unsupported.length + validation.playbookOnly.length,
    ).toBe(validation.contentFiles);
  });

  it.skipIf(!present)('every fixture not listed as a known failure passes', () => {
    const known = failureKeys(baseline);
    const broken = validation.evaluated.flatMap((rule) =>
      rule.fixtures
        .filter((f) => !f.passed && !known.has(fixtureKey(rule.ruleId, f.kind, f.index, f.event)))
        .map((f) => `${rule.rulePath} ${f.kind} #${f.index}: ${f.reason ?? ''}`),
    );
    expect(broken, `new failing fixtures; fix them or ${refresh}`).toEqual([]);
  });

  it.skipIf(!present)('known failures that still exist still fail (the list is not stale)', () => {
    const passing = new Set(
      validation.evaluated.flatMap((rule) =>
        rule.fixtures
          .filter((f) => f.passed)
          .map((f) => fixtureKey(rule.ruleId, f.kind, f.index, f.event)),
      ),
    );
    const stale = baseline.failures
      .filter((f) => passing.has(fixtureKey(f.ruleId, f.kind, f.index, f.event)))
      .map((f) => `${f.rulePath} ${f.kind} #${f.index}`);
    expect(stale, `listed failures now pass; ${refresh}`).toEqual([]);
  });

  it.skipIf(!present)('most fixtures pass and the suite is fast', () => {
    const fixtures = validation.evaluated.flatMap((rule) => rule.fixtures);
    const passed = fixtures.filter((f) => f.passed).length;
    expect(fixtures.length).toBeGreaterThanOrEqual(minFixtures);
    expect(passed / fixtures.length).toBeGreaterThan(0.95);
    // PLAN S7: the regression suite runs in under 30 seconds.
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
