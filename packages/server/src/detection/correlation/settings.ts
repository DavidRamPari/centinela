/**
 * Parse and validate the `correlation` block of a rule (ARCHITECTURE §6): the supported
 * subset of the Sigma correlation specification. Anything else makes the rule unsupported
 * with a machine-readable reason.
 */
import { UnsupportedRuleError } from '../errors.js';
import { correlationBlockSchema, describeIssue } from '../rules/schema.js';
import { CORRELATION_TYPES, type CorrelationSettings, type CorrelationType } from '../types.js';

const TIMESPAN = /^(\d{1,9})([smhd])$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `5m` → 300000. Integer plus `s`, `m`, `h` or `d`; zero is not a window. */
export function parseTimespan(text: string): number {
  const match = TIMESPAN.exec(text.trim());
  const amount = Number(match?.[1]);
  const unit = UNIT_MS[match?.[2] ?? ''];
  if (!match || unit === undefined || amount <= 0) {
    throw new UnsupportedRuleError('correlation:timespan', text);
  }
  return amount * unit;
}

function isCorrelationType(type: string): type is CorrelationType {
  return (CORRELATION_TYPES as readonly string[]).includes(type);
}

function threshold(key: string, value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new UnsupportedRuleError('correlation:condition', `${key}: ${String(value)}`);
  }
  return number;
}

export function parseCorrelationSettings(block: unknown): CorrelationSettings {
  const parsed = correlationBlockSchema.safeParse(block);
  if (!parsed.success) {
    throw new UnsupportedRuleError('correlation:invalid', describeIssue(parsed.error));
  }
  const data = parsed.data;
  if (!isCorrelationType(data.type)) throw new UnsupportedRuleError('correlation:type', data.type);
  if (data.aliases !== undefined) throw new UnsupportedRuleError('correlation:aliases');

  if (data.timespan !== undefined && data.timeframe !== undefined) {
    throw new UnsupportedRuleError('correlation:timespan', 'both timespan and timeframe');
  }
  const span = data.timespan ?? data.timeframe;
  if (span === undefined) throw new UnsupportedRuleError('correlation:timespan', 'missing');
  const timespanMs = parseTimespan(span);

  const condition = data.condition ?? {};
  const temporal = data.type === 'temporal' || data.type === 'temporal_ordered';
  if (temporal && data.condition !== undefined) {
    throw new UnsupportedRuleError('correlation:condition', `not supported for ${data.type}`);
  }
  for (const key of Object.keys(condition)) {
    if (key === 'gt' || key === 'gte') continue;
    if (key === 'field' && data.type === 'value_count') continue;
    throw new UnsupportedRuleError('correlation:condition', key);
  }
  const gt = threshold('gt', condition['gt']);
  const gte = threshold('gte', condition['gte']);
  if (!temporal && gt === null && gte === null) {
    throw new UnsupportedRuleError('correlation:condition', 'missing gt or gte');
  }
  const field = condition['field'];
  if (data.type === 'value_count' && (typeof field !== 'string' || field.trim() === '')) {
    throw new UnsupportedRuleError('correlation:condition', 'value_count needs field');
  }

  return {
    type: data.type,
    ruleRefs: typeof data.rules === 'string' ? [data.rules] : data.rules,
    groupBy: data['group-by'] ?? [],
    timespanMs,
    gt,
    gte,
    valueField: typeof field === 'string' ? field.trim() : null,
    generate: data.generate ?? false,
  };
}

/** Thresholds are evaluated after each new match; several combine with AND. */
export function meetsThreshold(settings: Pick<CorrelationSettings, 'gt' | 'gte'>, n: number) {
  return (settings.gt === null || n > settings.gt) && (settings.gte === null || n >= settings.gte);
}
