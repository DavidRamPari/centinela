/**
 * Fixture validation (session S7): every fixture event of every content file is evaluated
 * directly against its rule's compiled detection. Positive fixtures must match, negative
 * fixtures must not. Logsource routing is not involved: a fixture tests the detection
 * logic, and the fixture events do not say which Centinela source they would come from.
 *
 * The event is the field view as it is. `message` (keyword searches) is the event's own
 * `message` field when it has one, otherwise the event's JSON text, as for the SigmaHQ
 * regression samples (S2-09).
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventView, MAX_MATCH_LENGTH } from '../detection/event-view.js';
import type { RuleSet } from '../detection/rules/ruleset.js';
import type { CompiledSigmaRule } from '../detection/types.js';
import { createRuleExplainer, describeFailure, type RuleExplainer } from './explain.js';
import {
  contentFileSchema,
  FIXTURE_KINDS,
  fixtureFields,
  MAX_CONTENT_FILE_BYTES,
  type ContentFile,
  type ContentFixture,
  type FixtureKind,
} from './schema.js';
import type { SigmaFolder } from './rules.js';

export interface FixtureOutcome {
  kind: FixtureKind;
  /** Position in the content file's `fixtures.<kind>` list. */
  index: number;
  description: string;
  event: Record<string, unknown>;
  passed: boolean;
  /** Why the fixture failed; null when it passed. */
  reason: string | null;
  /** Result of each search identifier, for failed fixtures. */
  selections: Array<{ name: string; matched: boolean }> | null;
}

export interface RuleRef {
  ruleId: string;
  title: string;
  /** Rule path relative to the rules folder. */
  rulePath: string;
}

export interface RuleOutcome extends RuleRef {
  /** Content file name. */
  file: string;
  fixtures: FixtureOutcome[];
}

export interface UnsupportedRule extends RuleRef {
  file: string;
  reason: string;
  fixtures: number;
}

export interface ContentIssue {
  file: string;
  reason: string;
}

export interface ContentValidation {
  /** Sigma rules in the rules folder that content could exist for (not deprecated). */
  rulesTotal: number;
  /** Of those, rules the engine cannot compile (with or without content). */
  rulesUnsupported: number;
  /** Rule files that could not be loaded as rules at all. */
  ruleLoadErrors: number;
  /** Content files read (valid or not). */
  contentFiles: number;
  evaluated: RuleOutcome[];
  unsupported: UnsupportedRule[];
  /** Content files whose rule is not in the rules folder. */
  orphans: ContentIssue[];
  /** Content files that are not valid content (JSON or shape). */
  malformed: ContentIssue[];
  /** Rules without a content file. */
  missing: RuleRef[];
}

export interface ContentEntry {
  file: string;
  content: ContentFile;
}

export interface ReadContent {
  entries: ContentEntry[];
  malformed: ContentIssue[];
  files: number;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `<dir>/*.json`, sorted; symbolic links and hidden files are skipped. */
export function listContentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort(byName);
}

export function parseContentText(text: string): ContentFile | string {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return 'invalid JSON';
  }
  const parsed = contentFileSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return `invalid content (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'shape'})`;
}

export function readContentDir(dir: string): ReadContent {
  const entries: ContentEntry[] = [];
  const malformed: ContentIssue[] = [];
  const files = listContentFiles(dir);
  for (const file of files) {
    const path = join(dir, file);
    if (lstatSync(path).size > MAX_CONTENT_FILE_BYTES) {
      malformed.push({ file, reason: 'file too large' });
      continue;
    }
    const content = parseContentText(readFileSync(path, 'utf8'));
    if (typeof content === 'string') malformed.push({ file, reason: content });
    else entries.push({ file, content });
  }
  return { entries, malformed, files: files.length };
}

/** The view a fixture event is matched with (see the module comment). */
export function fixtureView(event: Record<string, unknown>, ruleSet: RuleSet): EventView {
  const fields = fixtureFields(event);
  const own = fields['message'];
  const message = typeof own === 'string' ? own : JSON.stringify(fields);
  return new EventView(
    { message: message.slice(0, MAX_MATCH_LENGTH), fields },
    ruleSet.memoSlots,
  );
}

export function evaluateFixture(
  ruleSet: RuleSet,
  rule: CompiledSigmaRule,
  explainer: RuleExplainer | null,
  kind: FixtureKind,
  index: number,
  fixture: ContentFixture,
): FixtureOutcome {
  const expected = kind === 'positive';
  const view = fixtureView(fixture.event, ruleSet);
  const matched = rule.detection.matches(view);
  const base = { kind, index, description: fixture.description, event: fixture.event };
  if (matched === expected) return { ...base, passed: true, reason: null, selections: null };
  if (explainer === null) {
    return {
      ...base,
      passed: false,
      reason: expected ? 'expected a match, but the rule did not match' : 'expected no match, but the rule matched',
      selections: rule.detection.explain(view),
    };
  }
  const explanation = explainer.explain(view, expected);
  return {
    ...base,
    passed: false,
    reason: describeFailure(explanation, expected),
    selections: explanation.selections.map(({ name, matched: hit }) => ({ name, matched: hit })),
  };
}

function isContentCandidate(status: string | null): boolean {
  const lower = status?.toLowerCase();
  return lower !== 'deprecated' && lower !== 'unsupported';
}

export function validateContent(folder: SigmaFolder, content: ReadContent): ContentValidation {
  const { ruleSet } = folder;
  const evaluated: RuleOutcome[] = [];
  const unsupported: UnsupportedRule[] = [];
  const orphans: ContentIssue[] = [];
  const covered = new Set<string>();

  for (const { file, content: data } of content.entries) {
    const record = ruleSet.rule(data.rule.id);
    if (!record || record.meta.type !== 'sigma') {
      orphans.push({ file, reason: `no Sigma rule with id ${data.rule.id} in the rules folder` });
      continue;
    }
    covered.add(record.meta.id.toLowerCase());
    const ref: RuleRef = {
      ruleId: record.meta.id,
      title: record.meta.title,
      rulePath: folder.relPath(record.meta.path),
    };
    const compiled = record.compiled;
    if (!record.meta.supported || compiled?.kind !== 'sigma') {
      unsupported.push({
        ...ref,
        file,
        reason: record.meta.unsupportedReason ?? 'not a Sigma rule',
        fixtures: data.fixtures.positive.length + data.fixtures.negative.length,
      });
      continue;
    }
    const explainer = createRuleExplainer(record.source);
    const fixtures = FIXTURE_KINDS.flatMap((kind) =>
      data.fixtures[kind].map((fixture, index) =>
        evaluateFixture(ruleSet, compiled, explainer, kind, index, fixture),
      ),
    );
    evaluated.push({ ...ref, file, fixtures });
  }

  const candidates = ruleSet.rules.filter(
    (r) => r.meta.type === 'sigma' && isContentCandidate(r.meta.status),
  );
  const missing = candidates
    .filter((r) => !covered.has(r.meta.id.toLowerCase()))
    .map((r) => ({ ruleId: r.meta.id, title: r.meta.title, rulePath: folder.relPath(r.meta.path) }));

  return {
    rulesTotal: candidates.length,
    rulesUnsupported: candidates.filter((r) => !r.meta.supported).length,
    ruleLoadErrors: ruleSet.errors.length,
    contentFiles: content.files,
    evaluated,
    unsupported,
    orphans,
    malformed: content.malformed,
    missing,
  };
}
