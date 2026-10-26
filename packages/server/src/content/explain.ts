/**
 * Explain why a fixture event did or did not match a rule: the result of every search
 * identifier and detection item, and which identifiers made the condition come out wrong.
 * The explanation goes into the failures file, where `tools/content-pack repair` sends it
 * to the model, so it names fields and modifiers the way the rule writes them.
 *
 * Items are compiled again here without the rule set's shared cache, with the same
 * functions the engine uses (`compileDetectionItem`), so each item can be evaluated on its
 * own. The engine's own verdict always decides pass or fail; this module only explains it.
 */
import type { EventView } from '../detection/event-view.js';
import { parseRuleYaml } from '../detection/rules/ruleset.js';
import { parseCondition, type ConditionNode } from '../detection/sigma/condition.js';
import {
  compileDetectionItem,
  splitDetectionKey,
  type DetectionItem,
} from '../detection/sigma/modifiers.js';

export interface ItemResult {
  /** `field|modifier|...` as written in the rule, or `keywords` for a value list. */
  key: string;
  matched: boolean;
  /** The item reads a field the event does not have (or has as null). */
  missing: boolean;
}

export interface SelectionResult {
  name: string;
  matched: boolean;
  /** One entry per map of the selection (a list of maps is an OR of its maps). */
  alternatives: ItemResult[][];
}

export interface Explanation {
  condition: string;
  selections: SelectionResult[];
  /** Identifiers whose result made the condition differ from the expected one. */
  blame: Array<{ name: string; wanted: boolean }>;
}

interface ItemExplainer {
  key: string;
  field: string | null;
  item: DetectionItem;
}

interface SelectionExplainer {
  name: string;
  alternatives: ItemExplainer[][];
}

export interface RuleExplainer {
  condition: string;
  explain(view: EventView, expected: boolean): Explanation;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapItems(map: Record<string, unknown>): ItemExplainer[] {
  return Object.entries(map).map(([key, value]) => {
    const { field, modifiers } = splitDetectionKey(key);
    return { key, field, item: compileDetectionItem(field, modifiers, value) };
  });
}

function keywordItems(values: unknown): ItemExplainer[] {
  return [{ key: 'keywords', field: null, item: compileDetectionItem(null, [], values) }];
}

function selectionExplainer(name: string, value: unknown): SelectionExplainer {
  if (isPlainObject(value)) return { name, alternatives: [mapItems(value)] };
  if (Array.isArray(value)) {
    const list = value as unknown[];
    const maps = list.filter(isPlainObject);
    const keywords = list.filter((entry) => !isPlainObject(entry));
    const alternatives = maps.map(mapItems);
    if (keywords.length > 0) alternatives.unshift(keywordItems(keywords));
    return { name, alternatives };
  }
  return { name, alternatives: [keywordItems(value)] };
}

function evaluate(node: ConditionNode, results: ReadonlyMap<string, boolean>): boolean {
  switch (node.op) {
    case 'ref':
      return results.get(node.name) ?? false;
    case 'not':
      return !evaluate(node.arg, results);
    case 'and':
      return node.args.every((arg) => evaluate(arg, results));
    case 'or':
      return node.args.some((arg) => evaluate(arg, results));
  }
}

/**
 * Identifiers to change for `node` to evaluate to `wanted`: under an AND that must become
 * true (or an OR that must become false) every child with the wrong value is to blame;
 * under an AND that must become false (or an OR that must become true) any child could
 * be changed, so all of them are listed.
 */
function blame(
  node: ConditionNode,
  wanted: boolean,
  results: ReadonlyMap<string, boolean>,
  out: Array<{ name: string; wanted: boolean }>,
): void {
  if (evaluate(node, results) === wanted) return;
  switch (node.op) {
    case 'ref':
      if (!out.some((entry) => entry.name === node.name && entry.wanted === wanted)) {
        out.push({ name: node.name, wanted });
      }
      return;
    case 'not':
      blame(node.arg, !wanted, results, out);
      return;
    case 'and':
    case 'or':
      for (const arg of node.args) blame(arg, wanted, results, out);
  }
}

/** Build an explainer from the rule's YAML text; null when the rule cannot be read. */
export function createRuleExplainer(source: string): RuleExplainer | null {
  const parsed = parseRuleYaml(source);
  if ('error' in parsed || !isPlainObject(parsed.doc)) return null;
  const detection = parsed.doc['detection'];
  if (!isPlainObject(detection)) return null;
  const raw = detection['condition'];
  const conditions = (Array.isArray(raw) ? (raw as unknown[]) : [raw]).filter(
    (c): c is string => typeof c === 'string',
  );
  const identifiers = Object.keys(detection).filter((key) => key !== 'condition');
  let trees: ConditionNode[];
  let selections: SelectionExplainer[];
  try {
    trees = conditions.map((text) => parseCondition(text, identifiers));
    selections = identifiers.map((name) => selectionExplainer(name, detection[name]));
  } catch {
    return null;
  }
  const tree: ConditionNode = trees.length === 1 && trees[0] ? trees[0] : { op: 'or', args: trees };
  const condition = conditions.join(' or ');

  return {
    condition,
    explain(view, expected) {
      const results = new Map<string, boolean>();
      const selectionResults = selections.map(({ name, alternatives }) => {
        const evaluated = alternatives.map((items) =>
          items.map(({ key, field, item }) => ({
            key,
            matched: item.test(view),
            missing: field !== null && !view.has(field),
          })),
        );
        const matched = evaluated.some((items) => items.every((item) => item.matched));
        results.set(name, matched);
        return { name, matched, alternatives: evaluated };
      });
      const blamed: Array<{ name: string; wanted: boolean }> = [];
      blame(tree, expected, results, blamed);
      return { condition, selections: selectionResults, blame: blamed };
    },
  };
}

function itemText(item: ItemResult): string {
  return item.missing ? `${item.key}: field missing` : item.key;
}

/** Why a selection did not match: the failing items of its closest alternative. */
function whyNot(selection: SelectionResult): string {
  let closest: ItemResult[] = [];
  let best = Number.NEGATIVE_INFINITY;
  for (const items of selection.alternatives) {
    // Fewest failing items wins; the first alternative wins ties.
    const score = items.filter((item) => item.matched).length - items.length;
    if (score > best) {
      best = score;
      closest = items;
    }
  }
  const failed = closest.filter((item) => !item.matched).map(itemText);
  const prefix = selection.alternatives.length > 1 ? 'closest alternative failed' : 'failed';
  return failed.length === 0 ? '' : ` (${prefix}: ${failed.join('; ')})`;
}

/** Why a selection matched: the items of the first alternative that matched. */
function whyYes(selection: SelectionResult): string {
  const hit = selection.alternatives.find((items) => items.every((item) => item.matched));
  return hit && hit.length > 0 ? ` (matched: ${hit.map((item) => item.key).join('; ')})` : '';
}

/**
 * One-line reason for a failed fixture, for example:
 * `expected a match, but the condition "selection and not filter" is false: selection
 * did not match (failed: CommandLine|contains|all)`.
 */
export function describeFailure(explanation: Explanation, expected: boolean): string {
  const byName = new Map(explanation.selections.map((s) => [s.name, s]));
  const head = expected
    ? `expected a match, but the condition "${explanation.condition}" is false`
    : `expected no match, but the condition "${explanation.condition}" is true`;
  const parts = explanation.blame.map(({ name, wanted }) => {
    const selection = byName.get(name);
    if (!selection) return name;
    return wanted
      ? `${name} did not match${whyNot(selection)}`
      : `${name} matched${whyYes(selection)}`;
  });
  return parts.length === 0 ? head : `${head}: ${parts.join('; ')}`;
}
