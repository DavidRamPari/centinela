/**
 * Detection engine entry point (ARCHITECTURE §5–§7): the Sigma loader and compiler, the
 * correlation engine and alert candidates, behind `createDetector()`.
 *
 * Rule sets are loaded once per rules folder and process (compiling about 1,250 rules
 * takes a second or two) and shared by every detector; each detector keeps its own
 * correlation state and enabled flags. Loading happens on first use, so creating a
 * pipeline that never sees an event costs nothing.
 */
import { resolve } from 'node:path';
import type { AttackIndex } from '@centinela/shared';
import { loadAttackIndexSync } from '@centinela/shared/node';
import { createEngine, type DetectionEngine } from './engine.js';
import { readRuleSources, readSigmaCommit } from './rules/loader.js';
import { buildRuleSet, type RuleSet } from './rules/ruleset.js';

export type { DetectionEngine } from './engine.js';
export type { LoadError, RuleRecord, RuleSet } from './rules/ruleset.js';

export interface DetectorOptions {
  /** Absolute path of the `rules/` folder. */
  rulesDir: string;
}

export interface LoadRuleSetOptions {
  /** ATT&CK index for tactics (default: `data/mitre-attack/enterprise-attack.min.json`). */
  attack?: AttackIndex;
}

const cache = new Map<string, RuleSet>();

/** Read, validate and compile every rule below `rulesDir` (memoized per folder). */
export function loadRuleSet(rulesDir: string, options: LoadRuleSetOptions = {}): RuleSet {
  const dir = resolve(rulesDir);
  const cached = cache.get(dir);
  if (cached) return cached;
  const ruleSet = buildRuleSet(readRuleSources(dir), {
    sigmaCommit: readSigmaCommit(dir),
    attack: options.attack ?? loadAttackIndexSync(),
  });
  cache.set(dir, ruleSet);
  return ruleSet;
}

export function createDetector(options: DetectorOptions): DetectionEngine {
  let engine: DetectionEngine | undefined;
  const get = (): DetectionEngine => (engine ??= createEngine(loadRuleSet(options.rulesDir)));
  return {
    get ruleSet() {
      return get().ruleSet;
    },
    get watermark() {
      return get().watermark;
    },
    process: (event) => get().process(event),
    flush: (watermark) => get().flush(watermark),
    rules: () => get().rules(),
    setRuleEnabled: (id, enabled) => get().setRuleEnabled(id, enabled),
  };
}
