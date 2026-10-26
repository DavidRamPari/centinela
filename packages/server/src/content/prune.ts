/**
 * `npm run content:validate -- --prune`: move failing fixtures out of the content files
 * into the rejected folder (default `content/sigma-rejected/`), one file per rule with
 * each fixture's kind, original index and the engine's reason. Playbooks and passing
 * fixtures stay where they are. Running it again with nothing failing changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson, FIXTURE_KINDS, type FixtureKind } from './schema.js';
import type { RuleOutcome } from './validate.js';

export const rejectedFileSchema = z.object({
  rule: z.object({ id: z.string(), title: z.string(), path: z.string() }),
  rejected: z.array(
    z.object({
      kind: z.enum(FIXTURE_KINDS),
      index: z.number().int().min(0),
      description: z.string(),
      event: z.record(z.string(), z.unknown()),
      reason: z.string(),
    }),
  ),
});
export type RejectedFile = z.infer<typeof rejectedFileSchema>;

export interface PruneResult {
  files: number;
  fixtures: number;
}

/** Write through a temporary file and a rename, so a crash never leaves half a file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRejected(path: string): RejectedFile | null {
  if (!existsSync(path)) return null;
  return rejectedFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export function pruneFailures(
  contentDir: string,
  rejectedDir: string,
  rules: readonly RuleOutcome[],
): PruneResult {
  let files = 0;
  let moved = 0;
  for (const rule of rules) {
    const failed = rule.fixtures.filter((f) => !f.passed);
    if (failed.length === 0) continue;
    const path = join(contentDir, rule.file);
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(data) || !isRecord(data['fixtures'])) {
      throw new Error(`${rule.file}: not a content file`);
    }
    const fixtures = data['fixtures'];
    const drop = new Map<FixtureKind, Set<number>>(FIXTURE_KINDS.map((kind) => [kind, new Set()]));
    for (const fixture of failed) {
      const list = fixtures[fixture.kind];
      const current: unknown = Array.isArray(list) ? (list as unknown[])[fixture.index] : undefined;
      const event = isRecord(current) ? current['event'] : undefined;
      // Never drop a fixture that changed since it was evaluated.
      if (canonicalJson(event) !== canonicalJson(fixture.event)) {
        throw new Error(`${rule.file}: ${fixture.kind} #${fixture.index} changed during validation`);
      }
      drop.get(fixture.kind)?.add(fixture.index);
    }
    for (const kind of FIXTURE_KINDS) {
      const list = fixtures[kind];
      if (!Array.isArray(list)) continue;
      const dropped = drop.get(kind) ?? new Set<number>();
      fixtures[kind] = (list as unknown[]).filter((_entry, index) => !dropped.has(index));
    }

    mkdirSync(rejectedDir, { recursive: true });
    const rejectedPath = join(rejectedDir, rule.file);
    const rejected: RejectedFile = readRejected(rejectedPath) ?? {
      rule: { id: rule.ruleId, title: rule.title, path: rule.rulePath },
      rejected: [],
    };
    for (const fixture of failed) {
      rejected.rejected.push({
        kind: fixture.kind,
        index: fixture.index,
        description: fixture.description,
        event: fixture.event,
        reason: fixture.reason ?? '',
      });
    }
    // The rejected copy is written first: a crash in between duplicates, never loses.
    writeJsonAtomic(rejectedPath, rejected);
    writeJsonAtomic(path, data);
    files += 1;
    moved += failed.length;
  }
  return { files, fixtures: moved };
}
