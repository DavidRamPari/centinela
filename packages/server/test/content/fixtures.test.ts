/**
 * Content-pack regression suite (session S7). Every fixture of `content/sigma` that is not
 * listed in `content/sigma-failures.json` must pass against its rule with the current
 * engine: positives match, negatives do not. Listed failures are skipped, so the suite
 * uses only the fixtures that pass; a listed failure that starts passing (an engine fix,
 * a repaired fixture) makes the list stale, and `npm run content:validate` refreshes it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { failureKeys, failuresFileSchema, fixtureKey, type FailuresFile } from '../../src/content/failures.js';
import { loadSigmaFolder } from '../../src/content/rules.js';
import { readContentDir, validateContent, type ContentValidation } from '../../src/content/validate.js';
import { repoRoot } from '../../src/paths.js';

const REFRESH = 'run `npm run content:validate` and commit content/sigma-failures.json';

describe('content pack fixtures (regression)', () => {
  let validation: ContentValidation;
  let baseline: FailuresFile;
  let elapsedMs = 0;

  beforeAll(() => {
    const started = performance.now();
    const folder = loadSigmaFolder(join(repoRoot, 'rules', 'sigma'));
    validation = validateContent(folder, readContentDir(join(repoRoot, 'content', 'sigma')));
    elapsedMs = performance.now() - started;
    baseline = failuresFileSchema.parse(
      JSON.parse(readFileSync(join(repoRoot, 'content', 'sigma-failures.json'), 'utf8')) as unknown,
    );
  }, 30_000);

  it('every content file is valid and belongs to a vendored rule', () => {
    expect(validation.malformed).toEqual([]);
    expect(validation.orphans).toEqual([]);
    expect(validation.evaluated.length + validation.unsupported.length).toBe(validation.contentFiles);
  });

  it('every fixture not listed as a known failure passes', () => {
    const known = failureKeys(baseline);
    const broken = validation.evaluated.flatMap((rule) =>
      rule.fixtures
        .filter((f) => !f.passed && !known.has(fixtureKey(rule.ruleId, f.kind, f.index, f.event)))
        .map((f) => `${rule.rulePath} ${f.kind} #${f.index}: ${f.reason ?? ''}`),
    );
    expect(broken, `new failing fixtures; fix them or ${REFRESH}`).toEqual([]);
  });

  it('known failures that still exist still fail (the list is not stale)', () => {
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
    expect(stale, `listed failures now pass; ${REFRESH}`).toEqual([]);
  });

  it('most fixtures pass and the suite is fast', () => {
    const fixtures = validation.evaluated.flatMap((rule) => rule.fixtures);
    const passed = fixtures.filter((f) => f.passed).length;
    expect(fixtures.length).toBeGreaterThan(4_000);
    expect(passed / fixtures.length).toBeGreaterThan(0.95);
    // ARCHITECTURE/PLAN S7: the regression suite runs in under 30 seconds.
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
