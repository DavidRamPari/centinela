/**
 * The failures file written by `npm run content:validate` (default
 * `content/sigma-failures.json`). It serves three readers:
 *
 * - `tools/content-pack/content_pack.py repair` sends each failing rule's fixtures and
 *   reasons to the model and writes the corrected fixtures back;
 * - `--prune` moves the listed fixtures to the rejected folder;
 * - the regression suite in `npm test` skips exactly the listed fixtures and requires
 *   every other fixture to pass, so a fixture that passed once can never silently break.
 *
 * Fixtures are identified by rule id, kind, index and event, so a fixture rewritten by
 * `repair` is no longer the listed failure and is tested again.
 */
import { z } from 'zod';
import { canonicalJson, FIXTURE_KINDS, type FixtureKind } from './schema.js';
import type { ContentValidation } from './validate.js';

export const FAILURES_FORMAT = 'centinela-content-failures/1';

const ruleRefSchema = z.object({
  ruleId: z.string(),
  title: z.string(),
  rulePath: z.string(),
  file: z.string(),
});

export const fixtureFailureSchema = ruleRefSchema.extend({
  kind: z.enum(FIXTURE_KINDS),
  index: z.number().int().min(0),
  description: z.string(),
  event: z.record(z.string(), z.unknown()),
  reason: z.string(),
  selections: z.array(z.object({ name: z.string(), matched: z.boolean() })).nullable(),
});
export type FixtureFailure = z.infer<typeof fixtureFailureSchema>;

export const failuresFileSchema = z.object({
  format: z.literal(FAILURES_FORMAT),
  rulesDir: z.string(),
  contentDir: z.string(),
  /** True when `--prune` moved the listed fixtures out of the content files. */
  pruned: z.boolean(),
  summary: z.object({
    rules: z.number().int(),
    fixtures: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
  }),
  unsupported: z.array(ruleRefSchema.extend({ reason: z.string(), fixtures: z.number().int() })),
  failures: z.array(fixtureFailureSchema),
});
export type FailuresFile = z.infer<typeof failuresFileSchema>;

export function buildFailuresFile(
  validation: ContentValidation,
  options: { rulesDir: string; contentDir: string; pruned: boolean },
): FailuresFile {
  const fixtures = validation.evaluated.flatMap((rule) => rule.fixtures);
  const failures: FixtureFailure[] = validation.evaluated.flatMap((rule) =>
    rule.fixtures
      .filter((fixture) => !fixture.passed)
      .map((fixture) => ({
        ruleId: rule.ruleId,
        title: rule.title,
        rulePath: rule.rulePath,
        file: rule.file,
        kind: fixture.kind,
        index: fixture.index,
        description: fixture.description,
        event: fixture.event,
        reason: fixture.reason ?? '',
        selections: fixture.selections,
      })),
  );
  const passed = fixtures.filter((fixture) => fixture.passed).length;
  return {
    format: FAILURES_FORMAT,
    rulesDir: options.rulesDir,
    contentDir: options.contentDir,
    pruned: options.pruned,
    summary: {
      rules: validation.evaluated.length,
      fixtures: fixtures.length,
      passed,
      failed: fixtures.length - passed,
    },
    unsupported: validation.unsupported.map(({ ruleId, title, rulePath, file, reason, fixtures: n }) => ({
      ruleId,
      title,
      rulePath,
      file,
      reason,
      fixtures: n,
    })),
    failures,
  };
}

/** Identity of a fixture: rule id, kind, index and the event's canonical JSON. */
export function fixtureKey(
  ruleId: string,
  kind: FixtureKind,
  index: number,
  event: Record<string, unknown>,
): string {
  return `${ruleId.toLowerCase()}|${kind}|${index}|${canonicalJson(event)}`;
}

export function failureKeys(file: FailuresFile): Set<string> {
  return new Set(file.failures.map((f) => fixtureKey(f.ruleId, f.kind, f.index, f.event)));
}
