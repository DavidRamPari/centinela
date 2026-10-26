/** Compiled rules shared by the rule set builder and the engine. */
import type { LogSource, RuleMeta } from '@centinela/shared';
import type { AlertRuleInfo } from '../pipeline/types.js';
import type { CompiledDetection } from './sigma/compile.js';

export interface CompiledSigmaRule {
  readonly kind: 'sigma';
  readonly meta: RuleMeta;
  readonly info: AlertRuleInfo;
  readonly logsource: LogSource;
  readonly detection: CompiledDetection;
  /** Supported correlations that reference this rule, in dependency order. */
  readonly consumers: CompiledCorrelation[];
}

export const CORRELATION_TYPES = [
  'event_count',
  'value_count',
  'temporal',
  'temporal_ordered',
] as const;
export type CorrelationType = (typeof CORRELATION_TYPES)[number];

export interface CorrelationSettings {
  type: CorrelationType;
  /** References as written in the rule (`name` or `id`). */
  ruleRefs: string[];
  groupBy: string[];
  timespanMs: number;
  /** Thresholds; several combine with AND. Null when not set. */
  gt: number | null;
  gte: number | null;
  /** `condition.field` of `value_count`. */
  valueField: string | null;
  generate: boolean;
}

export interface CompiledCorrelation extends Omit<CorrelationSettings, 'ruleRefs'> {
  readonly kind: 'correlation';
  readonly meta: RuleMeta;
  readonly info: AlertRuleInfo;
  /** Resolved rule ids, in the listed order (a rule may appear twice). */
  readonly refs: readonly string[];
  /** Supported correlations that reference this one, in dependency order. */
  readonly consumers: CompiledCorrelation[];
  /** Position in dependency order: inner correlations come first. */
  readonly order: number;
}

export type CompiledRule = CompiledSigmaRule | CompiledCorrelation;
