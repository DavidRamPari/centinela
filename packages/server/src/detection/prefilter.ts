/**
 * Rule prefilter. Each compiled rule carries `requires`: literal ids of which at least one
 * must match for the rule to be true (see `sigma/compile.ts`). For an event, the fields
 * those literals belong to are scanned once through the `LiteralIndex`; only rules whose
 * requirement is met, plus rules without one, are evaluated, in their usual order. The
 * prefilter only ever skips rules that cannot match: results are identical with it off
 * (tested against exhaustive evaluation).
 */
import type { EventView } from './event-view.js';
import type { LiteralField, LiteralIndex } from './sigma/literal-index.js';
import type { CompiledSigmaRule } from './types.js';

export interface RulePlan {
  readonly rules: readonly CompiledSigmaRule[];
  /** 1 for rules evaluated for every event (no literal requirement). */
  readonly always: Uint8Array;
  /** Literal id → positions in `rules` of the rules that require it. */
  readonly byLiteral: ReadonlyMap<number, readonly number[]>;
  /** Fields owning a literal in `byLiteral`. */
  readonly scan: readonly LiteralField[];
}

export function buildRulePlan(rules: readonly CompiledSigmaRule[], index: LiteralIndex): RulePlan {
  const always = new Uint8Array(rules.length);
  const byLiteral = new Map<number, number[]>();
  const scan = new Map<number, LiteralField>();
  rules.forEach((rule, position) => {
    const requires = rule.detection.requires;
    if (requires === null || requires.size === 0) {
      always[position] = 1;
      return;
    }
    for (const id of requires) {
      const positions = byLiteral.get(id) ?? [];
      positions.push(position);
      byLiteral.set(id, positions);
      const owner = index.fieldOf(id);
      if (owner) scan.set(owner.slot, owner);
    }
  });
  return { rules, always, byLiteral, scan: [...scan.values()] };
}

/** The rules of the plan that may match the event, in plan order. */
export function selectRules(
  plan: RulePlan,
  view: EventView,
  index: LiteralIndex,
): readonly CompiledSigmaRule[] {
  if (plan.byLiteral.size === 0) return plan.rules;
  const marks = plan.always.slice();
  for (const { slot, field } of plan.scan) {
    for (const id of view.literals(index, slot, field)) {
      const positions = plan.byLiteral.get(id);
      if (positions) for (const position of positions) marks[position] = 1;
    }
  }
  const selected: CompiledSigmaRule[] = [];
  for (let i = 0; i < plan.rules.length; i += 1) {
    const rule = plan.rules[i];
    if (marks[i] === 1 && rule) selected.push(rule);
  }
  return selected;
}
