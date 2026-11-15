/**
 * The detector's state as plain data (ARCHITECTURE §6.3): the correlation windows of every
 * rule plus the engine's watermark, so a restart can continue where the last run stopped.
 * A snapshot comes back from the database, so it is validated like any other input before
 * the engine trusts it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompiledCorrelation } from './types.js';

const eventRefSchema = z.object({
  id: z.string(),
  ts: z.string(),
  time: z.number(),
  host: z.string(),
  ip: z.string().optional(),
  user: z.string().optional(),
});

const entrySchema = z.object({
  ruleId: z.string(),
  time: z.number(),
  value: z.string().optional(),
  events: z.array(eventRefSchema),
});

const groupSchema = z.object({
  values: z.array(z.string()),
  /** Time of the newest match. */
  newest: z.number(),
  /** The detector's clock when the group last took a match (what eviction counts from). */
  seen: z.number(),
  entries: z.array(entrySchema),
});
export type GroupSnapshot = z.infer<typeof groupSchema>;

const correlationSnapshotSchema = z.object({
  /** Rule id. */
  id: z.string(),
  /** `correlationFingerprint` of the rule when the snapshot was taken. */
  fingerprint: z.string(),
  /** In creation order (the order in which a full correlation drops groups). */
  groups: z.array(groupSchema),
});
export type CorrelationSnapshot = z.infer<typeof correlationSnapshotSchema>;

export const engineSnapshotSchema = z.object({
  watermark: z.number().nullable(),
  /** Event time of the last sweep of expired groups; null before the first one. */
  lastSweep: z.number().nullable(),
  correlations: z.array(correlationSnapshotSchema),
});
export type EngineSnapshot = z.infer<typeof engineSnapshotSchema>;

/**
 * Identifies what a correlation's saved windows mean. If any of these change between two
 * runs (another timespan, another group-by, other rules), the saved state belongs to a
 * different rule and is dropped instead of restored.
 */
export function correlationFingerprint(rule: CompiledCorrelation): string {
  const shape = [
    rule.type,
    rule.refs,
    rule.groupBy,
    rule.timespanMs,
    rule.gt,
    rule.gte,
    rule.valueField,
  ];
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}
