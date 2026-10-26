/**
 * The loaded rules plus their persisted enable/disable flags (S2-07: the engine keeps the
 * flags in memory; `rule_state` keeps them across restarts and processes).
 *
 * `ready()` copies `rule_state` into the engine once. The pipeline awaits it before its
 * first batch and the rules API before answering, so a disabled rule never runs and is
 * never shown as enabled. A failed load (database down) is retried on the next call.
 */
import type { RuleMeta } from '@centinela/shared';
import type { Pool } from 'pg';
import { loadRuleState, saveRuleState } from '../db/rule-state.js';
import type { DetectionEngine } from '../detection/index.js';

export interface RuleDetail {
  meta: RuleMeta;
  /** The rule's YAML text. */
  source: string;
}

export interface RuleCatalog {
  ready(): Promise<void>;
  /** Every rule (supported or not) with its current `enabled` flag, in path order. */
  list(): RuleMeta[];
  /** A rule by id (case-insensitive). */
  get(id: string): RuleDetail | undefined;
  /** Persist and apply a flag; undefined when the id is unknown. */
  setEnabled(id: string, enabled: boolean): Promise<RuleMeta | undefined>;
}

export interface RuleCatalogOptions {
  engine: DetectionEngine;
  pool: Pool;
  now?: () => Date;
}

export function createRuleCatalog({ engine, pool, now }: RuleCatalogOptions): RuleCatalog {
  let loading: Promise<void> | undefined;

  function ready(): Promise<void> {
    loading ??= loadRuleState(pool).then(
      (state) => {
        for (const [id, enabled] of state) engine.setRuleEnabled(id, enabled);
      },
      (err: unknown) => {
        loading = undefined;
        throw err;
      },
    );
    return loading;
  }

  function meta(id: string): RuleMeta | undefined {
    const key = id.toLowerCase();
    return engine.rules().find((rule) => rule.id.toLowerCase() === key);
  }

  return {
    ready,
    list: () => engine.rules(),
    get(id) {
      const record = engine.ruleSet.rule(id);
      const current = record && meta(record.meta.id);
      return record && current ? { meta: current, source: record.source } : undefined;
    },
    async setEnabled(id, enabled) {
      await ready();
      const record = engine.ruleSet.rule(id);
      if (!record) return undefined;
      await saveRuleState(pool, record.meta.id, enabled, now?.());
      engine.setRuleEnabled(record.meta.id, enabled);
      return meta(record.meta.id);
    },
  };
}
