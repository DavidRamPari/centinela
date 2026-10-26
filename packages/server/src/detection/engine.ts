/**
 * The detector (ARCHITECTURE §2.3, §5–§7): routes each event to the Sigma rules for its
 * logsources, emits a candidate per match (except for building blocks), feeds matches to
 * the correlations that reference the rule, and feeds correlation firings to the
 * correlations that chain on them. Everything is driven by event time; the same events in
 * the same order always produce the same candidates in the same order.
 */
import type { NormalizedEvent, RuleMeta } from '@centinela/shared';
import type { AlertCandidate, Detector } from '../pipeline/types.js';
import { correlationCandidate, eventRef, sigmaCandidate } from './candidates.js';
import { CorrelationState, type CorrelationMatch } from './correlation/state.js';
import { EventView } from './event-view.js';
import { buildRulePlan, selectRules, type RulePlan } from './prefilter.js';
import type { RuleSet } from './rules/ruleset.js';
import type { CompiledCorrelation, CompiledSigmaRule } from './types.js';

/** Expired correlation groups are swept each time event time advances this much. */
export const SWEEP_INTERVAL_MS = 60_000;

export interface DetectionEngine extends Detector {
  readonly ruleSet: RuleSet;
  /** Every rule with its current `enabled` flag, in path order. */
  rules(): RuleMeta[];
  /** Enable or disable a rule by id; false when the id is unknown. */
  setRuleEnabled(id: string, enabled: boolean): boolean;
  /** Newest event time seen (epoch ms), or null before the first event. */
  readonly watermark: number | null;
}

export interface EngineOptions {
  /** Skip rules whose required literals did not match (default true; see `prefilter.ts`). */
  prefilter?: boolean;
}

export function createEngine(ruleSet: RuleSet, options: EngineOptions = {}): DetectionEngine {
  const prefilter = options.prefilter ?? true;
  /** Plans per routed rule list (the router returns the same array for the same shape). */
  const plans = new WeakMap<readonly CompiledSigmaRule[], RulePlan>();
  const rulesFor = (view: EventView, routed: readonly CompiledSigmaRule[]) => {
    if (!prefilter) return routed;
    let plan = plans.get(routed);
    if (!plan) {
      plan = buildRulePlan(routed, ruleSet.literals);
      plans.set(routed, plan);
    }
    return selectRules(plan, view, ruleSet.literals);
  };
  const states = new Map<CompiledCorrelation, CorrelationState>(
    ruleSet.correlations.map((rule) => [rule, new CorrelationState(rule)]),
  );
  const disabled = new Set<string>();
  let watermark: number | null = null;
  let lastSweep = Number.NEGATIVE_INFINITY;

  const isEnabled = (meta: RuleMeta) => disabled.size === 0 || !disabled.has(meta.id.toLowerCase());

  function advance(time: number): void {
    if (watermark === null || time > watermark) watermark = time;
    if (watermark - lastSweep >= SWEEP_INTERVAL_MS) {
      lastSweep = watermark;
      for (const state of states.values()) state.evict(watermark);
    }
  }

  function deliver(
    consumers: readonly CompiledCorrelation[],
    match: CorrelationMatch,
    out: AlertCandidate[],
  ): void {
    for (const correlation of consumers) {
      if (!isEnabled(correlation.meta)) continue;
      const firing = states.get(correlation)?.add(match);
      if (!firing) continue;
      out.push(correlationCandidate(firing));
      if (correlation.consumers.length > 0) {
        deliver(
          correlation.consumers,
          {
            ruleId: correlation.meta.id,
            time: firing.time,
            value: (field) => firing.groupValues.get(field),
            events: firing.events,
          },
          out,
        );
      }
    }
  }

  return {
    ruleSet,
    get watermark() {
      return watermark;
    },

    process(event: NormalizedEvent): AlertCandidate[] {
      const time = Date.parse(event.ts);
      if (Number.isNaN(time)) return [];
      advance(time);
      const view = new EventView(event, ruleSet.memoSlots);
      const ref = eventRef(event, time);
      const out: AlertCandidate[] = [];
      for (const rule of rulesFor(view, ruleSet.router.route(event.logsources))) {
        if (!isEnabled(rule.meta) || !rule.detection.matches(view)) continue;
        if (!rule.meta.buildingBlock) out.push(sigmaCandidate(rule, event, view, ref));
        if (rule.consumers.length > 0) {
          deliver(
            rule.consumers,
            { ruleId: rule.meta.id, time, value: (field) => view.text(field), events: [ref] },
            out,
          );
        }
      }
      return out;
    },

    flush(at: Date): AlertCandidate[] {
      const time = at.getTime();
      if (!Number.isNaN(time)) {
        if (watermark === null || time > watermark) watermark = time;
        lastSweep = watermark;
        for (const state of states.values()) state.evict(watermark);
      }
      // Conditions are evaluated on every match, so nothing is ever pending.
      return [];
    },

    rules() {
      return ruleSet.rules.map((record) => ({ ...record.meta, enabled: isEnabled(record.meta) }));
    },

    setRuleEnabled(id, enabled) {
      const record = ruleSet.rule(id);
      if (!record) return false;
      const key = record.meta.id.toLowerCase();
      if (enabled) {
        disabled.delete(key);
      } else {
        disabled.add(key);
        if (record.compiled?.kind === 'correlation') states.get(record.compiled)?.clear();
      }
      return true;
    },
  };
}
