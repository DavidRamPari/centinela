/**
 * Logsource routing (ARCHITECTURE §5.2). A rule applies to an event when, for at least one
 * entry of `event.logsources`, every key the rule's logsource sets (`product`, `service`,
 * `category`) equals the entry's value, ignoring case. Rules are indexed by their logsource
 * at load time; an entry with k keys can only be matched by the 2^k logsources made of a
 * subset of its keys, so routing is a handful of map lookups, cached per event shape.
 */
import type { LogSource } from '@centinela/shared';

const KEYS = ['product', 'service', 'category'] as const;

/** Canonical key of a (partial) logsource: lower-cased values, empty for unset keys. */
function canonical(source: LogSource): string {
  return KEYS.map((key) => source[key]?.toLowerCase() ?? '').join('|');
}

/** Every logsource a rule may declare and still apply to `entry`. */
function applicableKeys(entry: LogSource): string[] {
  const present = KEYS.filter((key) => entry[key] !== undefined);
  const keys: string[] = [];
  for (let mask = 0; mask < 1 << present.length; mask += 1) {
    const subset: LogSource = {};
    present.forEach((key, bit) => {
      if (mask & (1 << bit)) subset[key] = entry[key];
    });
    keys.push(canonical(subset));
  }
  return keys;
}

export interface LogsourceRouter<T> {
  /** Rules that apply to an event with these logsources, in the order they were given. */
  route(logsources: readonly LogSource[]): readonly T[];
}

/** Distinct event shapes are few (one per source and program); the cap is a safety net. */
const MAX_CACHED_SHAPES = 1024;

export function createLogsourceRouter<T>(
  rules: ReadonlyArray<{ logsource: LogSource; rule: T }>,
): LogsourceRouter<T> {
  const index = new Map<string, number[]>();
  rules.forEach(({ logsource }, position) => {
    const key = canonical(logsource);
    const list = index.get(key) ?? [];
    list.push(position);
    index.set(key, list);
  });
  const cache = new Map<string, readonly T[]>();

  return {
    route(logsources) {
      const shape = logsources.map(canonical).join(';');
      const cached = cache.get(shape);
      if (cached) return cached;
      const positions = new Set<number>();
      for (const entry of logsources) {
        for (const key of applicableKeys(entry)) {
          for (const position of index.get(key) ?? []) positions.add(position);
        }
      }
      const result = [...positions]
        .sort((a, b) => a - b)
        .map((position) => rules[position]?.rule)
        .filter((rule): rule is T => rule !== undefined);
      if (cache.size >= MAX_CACHED_SHAPES) cache.clear();
      cache.set(shape, result);
      return result;
    },
  };
}
