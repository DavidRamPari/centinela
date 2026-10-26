/**
 * Compile a Sigma `detection` block (ARCHITECTURE §5.3–§5.4) into a predicate:
 *
 * - a map is the AND of its detection items;
 * - a list of maps is the OR of the maps;
 * - a list of plain values (or a single value) is a keyword search on `message`;
 * - `condition` combines the search identifiers; a list of conditions is their OR.
 *
 * With a `CompileCache` (one per rule set):
 *
 * - identical selections and detection items across rules are compiled once and
 *   evaluated at most once per event (each gets a slot in `EventView.memo`);
 * - simple literal patterns go to the rule set's `LiteralIndex`;
 * - every predicate carries `requires`: literal ids of which at least one must match for
 *   the predicate to be true (AND keeps the smallest child set, OR the union of its
 *   children's, NOT and non-literal items give none). The engine skips a rule whose
 *   required literals did not match (`prefilter.ts`).
 */
import { UnsupportedRuleError } from '../errors.js';
import { MEMO_FALSE, MEMO_TRUE, MEMO_UNKNOWN, type EventView } from '../event-view.js';
import { compileCondition, parseCondition, type ConditionNode } from './condition.js';
import { LiteralIndex } from './literal-index.js';
import { compileDetectionItem, splitDetectionKey, type Requirement } from './modifiers.js';

export type ViewPredicate = (view: EventView) => boolean;

interface Compiled {
  test: ViewPredicate;
  requires: Requirement;
}

export interface CompiledDetection {
  matches: ViewPredicate;
  /** Literal ids of which at least one must match for the rule to match; null if unknown. */
  requires: Requirement;
  /** Search identifiers in declaration order. */
  identifiers: readonly string[];
  /** Result of each search identifier for an event (used to explain golden-test failures). */
  explain(view: EventView): Array<{ name: string; matched: boolean }>;
}

/**
 * Shared state of a rule set's compilation: memoized predicates (`slots` is the size
 * `EventView.memo` needs) and the index of simple literal patterns.
 */
export interface CompileCache {
  slots: number;
  readonly predicates: Map<string, Compiled>;
  readonly literals: LiteralIndex;
}

export function createCompileCache(): CompileCache {
  return { slots: 0, predicates: new Map(), literals: new LiteralIndex() };
}

/** AND: any child's requirement is necessary; keep the smallest. */
export function requireAll(children: readonly Requirement[]): Requirement {
  let best: Requirement = null;
  for (const child of children) {
    if (child !== null && (best === null || child.size < best.size)) best = child;
  }
  return best;
}

/** OR: one of the children must hold, so the union of their requirements (if all known). */
export function requireAny(children: readonly Requirement[]): Requirement {
  if (children.length === 0 || children.some((child) => child === null)) return null;
  if (children.length === 1) return children[0] ?? null;
  const union = new Set<number>();
  for (const child of children) for (const id of child ?? []) union.add(id);
  return union;
}

function memoized(
  cache: CompileCache | undefined,
  key: () => string,
  build: () => Compiled,
): Compiled {
  if (cache === undefined) return build();
  const id = key();
  const existing = cache.predicates.get(id);
  if (existing) return existing;
  const inner = build();
  const slot = cache.slots;
  cache.slots += 1;
  const test: ViewPredicate = (view) => {
    const memo = view.memo;
    if (memo === null || slot >= memo.length) return inner.test(view);
    const state = memo[slot];
    if (state !== MEMO_UNKNOWN) return state === MEMO_TRUE;
    const result = inner.test(view);
    memo[slot] = result ? MEMO_TRUE : MEMO_FALSE;
    return result;
  };
  const compiled = { test, requires: inner.requires };
  cache.predicates.set(id, compiled);
  return compiled;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function all(parts: Compiled[]): Compiled {
  if (parts.length === 1 && parts[0]) return parts[0];
  const tests = parts.map((p) => p.test);
  return {
    test: (view) => {
      for (let i = 0; i < tests.length; i += 1) if (!tests[i]?.(view)) return false;
      return true;
    },
    requires: requireAll(parts.map((p) => p.requires)),
  };
}

function any(parts: Compiled[]): Compiled {
  if (parts.length === 1 && parts[0]) return parts[0];
  const tests = parts.map((p) => p.test);
  return {
    test: (view) => {
      for (let i = 0; i < tests.length; i += 1) if (tests[i]?.(view)) return true;
      return false;
    },
    requires: requireAny(parts.map((p) => p.requires)),
  };
}

function compileItem(
  field: string | null,
  modifiers: string[],
  value: unknown,
  cache: CompileCache | undefined,
): Compiled {
  return memoized(
    cache,
    () => `item:${JSON.stringify([field, modifiers, value])}`,
    () => {
      const item = compileDetectionItem(field, modifiers, value, cache?.literals);
      return { test: (view) => item.test(view), requires: item.requires };
    },
  );
}

function compileMap(map: Record<string, unknown>, cache: CompileCache | undefined): Compiled {
  const entries = Object.entries(map);
  if (entries.length === 0) throw new UnsupportedRuleError('detection:empty-selection');
  return all(
    entries.map(([key, value]) => {
      const { field, modifiers } = splitDetectionKey(key);
      return compileItem(field, modifiers, value, cache);
    }),
  );
}

function compileSelection(value: unknown, cache: CompileCache | undefined): Compiled {
  return memoized(
    cache,
    () => `selection:${JSON.stringify(value)}`,
    () => compileSelectionUncached(value, cache),
  );
}

function compileSelectionUncached(value: unknown, cache: CompileCache | undefined): Compiled {
  if (isPlainObject(value)) return compileMap(value, cache);
  if (Array.isArray(value)) {
    const list = value as unknown[];
    if (list.length === 0) throw new UnsupportedRuleError('detection:empty-selection');
    const keywords = list.filter(isScalar);
    const maps = list.filter(isPlainObject);
    if (keywords.length + maps.length !== list.length) {
      throw new UnsupportedRuleError('detection:invalid-selection', 'nested list');
    }
    const parts: Compiled[] = [];
    if (keywords.length > 0) parts.push(compileItem(null, [], keywords, cache));
    for (const map of maps) parts.push(compileMap(map, cache));
    return any(parts);
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return compileItem(null, [], value, cache);
  }
  throw new UnsupportedRuleError(
    'detection:invalid-selection',
    value === null ? 'null' : typeof value,
  );
}

function conditionRequirement(
  node: ConditionNode,
  selection: (name: string) => Requirement,
): Requirement {
  switch (node.op) {
    case 'ref':
      return selection(node.name);
    case 'not':
      return null;
    case 'and':
      return requireAll(node.args.map((arg) => conditionRequirement(arg, selection)));
    case 'or':
      return requireAny(node.args.map((arg) => conditionRequirement(arg, selection)));
  }
}

export function compileDetection(
  detection: Record<string, unknown>,
  cache?: CompileCache,
): CompiledDetection {
  if (Object.hasOwn(detection, 'timeframe')) {
    throw new UnsupportedRuleError('detection:timeframe');
  }
  const rawCondition = detection['condition'];
  const conditions = Array.isArray(rawCondition) ? (rawCondition as unknown[]) : [rawCondition];
  const texts = conditions.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
  if (texts.length === 0 || texts.length !== conditions.length) {
    throw new UnsupportedRuleError('condition:missing');
  }

  const identifiers = Object.keys(detection).filter((key) => key !== 'condition');
  const trees: ConditionNode[] = texts.map((text) => parseCondition(text, identifiers));
  const selections = new Map<string, Compiled>();
  for (const name of identifiers) selections.set(name, compileSelection(detection[name], cache));

  const lookup = (name: string): Compiled => {
    const compiled = selections.get(name);
    if (!compiled) throw new UnsupportedRuleError('condition:unknown-identifier', name);
    return compiled;
  };
  const matches = any(
    trees.map((tree) => ({
      test: compileCondition(tree, (name) => lookup(name).test),
      requires: conditionRequirement(tree, (name) => lookup(name).requires),
    })),
  );

  return {
    matches: matches.test,
    requires: matches.requires,
    identifiers,
    explain: (view) =>
      identifiers.map((name) => ({ name, matched: selections.get(name)?.test(view) ?? false })),
  };
}
