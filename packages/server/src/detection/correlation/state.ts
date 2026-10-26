/**
 * Event-time sliding windows for one correlation rule (ARCHITECTURE §6).
 *
 * Matches are grouped by the `group-by` values; a match missing a group-by field does not
 * take part. Each group keeps its matches sorted by event time within
 * `[newest − timespan, newest]`. Matches more than 60 s older than the group's newest
 * match are ignored. The condition is evaluated after every new match; when it holds the
 * correlation fires once and the group's window is cleared, so the next alert needs a
 * fresh window. Groups are evicted when the watermark passes their newest match plus the
 * timespan.
 */
import { MAX_ALERT_EVENTS } from '@centinela/shared';
import type { CompiledCorrelation } from '../types.js';
import { meetsThreshold } from './settings.js';

/** An event that contributed to a match. */
export interface EventRef {
  id: string;
  ts: string;
  /** Event time, epoch milliseconds. */
  time: number;
  host: string;
  ip?: string;
  user?: string;
}

/** A Sigma rule match or a firing of an inner correlation, offered to a correlation. */
export interface CorrelationMatch {
  /** Id of the rule that matched. */
  ruleId: string;
  /** Event time of the match (for a chained firing, its last contributing event). */
  time: number;
  /** Field values for `group-by` and `condition.field`. */
  value(field: string): string | undefined;
  /** Contributing events, oldest first. */
  events: readonly EventRef[];
}

export interface CorrelationFiring {
  rule: CompiledCorrelation;
  /** `field=value` pairs joined by `,` in declared order; null without `group-by`. */
  groupKey: string | null;
  groupValues: ReadonlyMap<string, string>;
  /** Contributing events, oldest first, at most 100 (the most recent ones). */
  events: EventRef[];
  /** Time of the last contributing match. */
  time: number;
}

/** Events older than this relative to their group's newest match are ignored. */
export const LATE_TOLERANCE_MS = 60_000;
/** Bound on the matches one group keeps (oldest dropped first). */
export const MAX_ENTRIES_PER_GROUP = 1000;
/** Bound on the groups one correlation keeps (oldest-created dropped first). */
export const MAX_GROUPS_PER_CORRELATION = 100_000;

interface Entry {
  ruleId: string;
  time: number;
  value: string | undefined;
  events: readonly EventRef[];
}

interface Group {
  values: string[];
  newest: number;
  entries: Entry[];
}

/** Insert keeping entries sorted by time; equal times keep arrival order. */
function insertSorted(entries: Entry[], entry: Entry): void {
  let at = entries.length;
  while (at > 0 && (entries[at - 1]?.time ?? 0) > entry.time) at -= 1;
  entries.splice(at, 0, entry);
}

/**
 * Index of the first entry of the earliest complete ordered sequence, or -1. Taking the
 * earliest match of each step leaves the most room for the following steps.
 */
function orderedSequenceStart(entries: readonly Entry[], refs: readonly string[]): number {
  let step = 0;
  let start = -1;
  for (let i = 0; i < entries.length && step < refs.length; i += 1) {
    if (entries[i]?.ruleId === refs[step]) {
      if (step === 0) start = i;
      step += 1;
    }
  }
  return step === refs.length ? start : -1;
}

/** Contributing events of the entries: oldest first, unique, the most recent 100. */
export function mergeEvents(entries: readonly Entry[]): EventRef[] {
  const seen = new Set<string>();
  const events: EventRef[] = [];
  for (const entry of entries) {
    for (const event of entry.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  events.sort((a, b) => a.time - b.time);
  return events.length > MAX_ALERT_EVENTS ? events.slice(-MAX_ALERT_EVENTS) : events;
}

export class CorrelationState {
  readonly rule: CompiledCorrelation;
  private readonly groups = new Map<string, Group>();

  constructor(rule: CompiledCorrelation) {
    this.rule = rule;
  }

  /** Number of live groups (for tests and diagnostics). */
  get groupCount(): number {
    return this.groups.size;
  }

  clear(): void {
    this.groups.clear();
  }

  add(match: CorrelationMatch): CorrelationFiring | null {
    const { rule } = this;
    const values: string[] = [];
    for (const field of rule.groupBy) {
      const value = match.value(field);
      if (value === undefined) return null;
      values.push(value);
    }
    const value = rule.valueField === null ? undefined : match.value(rule.valueField);
    if (rule.type === 'value_count' && value === undefined) return null;

    const key = JSON.stringify(values);
    let group = this.groups.get(key);
    if (group === undefined) {
      if (this.groups.size >= MAX_GROUPS_PER_CORRELATION) {
        const oldest = this.groups.keys().next();
        if (!oldest.done) this.groups.delete(oldest.value);
      }
      group = { values, newest: Number.NEGATIVE_INFINITY, entries: [] };
      this.groups.set(key, group);
    }
    if (match.time < group.newest - LATE_TOLERANCE_MS) return null;

    const entry: Entry = { ruleId: match.ruleId, time: match.time, value, events: match.events };
    if (rule.type === 'value_count') {
      // Keep only the newest match per distinct value: the count is the number of entries.
      const same = group.entries.findIndex((e) => e.value === value);
      if (same !== -1) {
        if ((group.entries[same]?.time ?? 0) > match.time) return null;
        group.entries.splice(same, 1);
      }
    }
    insertSorted(group.entries, entry);
    group.newest = Math.max(group.newest, match.time);

    const windowStart = group.newest - rule.timespanMs;
    let expired = 0;
    while (expired < group.entries.length && (group.entries[expired]?.time ?? 0) < windowStart) {
      expired += 1;
    }
    if (expired > 0) group.entries.splice(0, expired);
    if (group.entries.length > MAX_ENTRIES_PER_GROUP) {
      group.entries.splice(0, group.entries.length - MAX_ENTRIES_PER_GROUP);
    }

    const contributing = this.evaluate(group.entries);
    if (contributing === null) return null;
    this.groups.delete(key);
    const groupValues = new Map(rule.groupBy.map((field, i) => [field, values[i] ?? '']));
    return {
      rule,
      groupKey:
        rule.groupBy.length === 0
          ? null
          : rule.groupBy.map((field, i) => `${field}=${values[i] ?? ''}`).join(','),
      groupValues,
      events: mergeEvents(contributing),
      time: contributing.reduce((latest, e) => Math.max(latest, e.time), Number.NEGATIVE_INFINITY),
    };
  }

  /** The entries that make the condition hold, or null when it does not. */
  private evaluate(entries: Entry[]): Entry[] | null {
    const { rule } = this;
    switch (rule.type) {
      case 'event_count':
      case 'value_count':
        return meetsThreshold(rule, entries.length) ? entries : null;
      case 'temporal': {
        const seen = new Set(entries.map((e) => e.ruleId));
        return rule.refs.every((ref) => seen.has(ref)) ? entries : null;
      }
      case 'temporal_ordered': {
        const start = orderedSequenceStart(entries, rule.refs);
        return start === -1 ? null : entries.slice(start);
      }
    }
  }

  /** Drop groups whose newest match is older than `watermark − timespan`. */
  evict(watermark: number): void {
    for (const [key, group] of this.groups) {
      if (watermark > group.newest + this.rule.timespanMs) this.groups.delete(key);
    }
  }
}
