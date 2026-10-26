import { z } from 'zod';
import { ipAddressSchema, utcTimestampSchema } from './events.js';

export const LEVELS = ['informational', 'low', 'medium', 'high', 'critical'] as const;
export const levelSchema = z.enum(LEVELS);
export type Level = z.infer<typeof levelSchema>;

/** Sorting weight per level (ARCHITECTURE §7). */
export const LEVEL_WEIGHT: Readonly<Record<Level, number>> = {
  informational: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/**
 * A new match folds into an open alert with the same dedup key when it starts at most
 * this long after the alert's `lastSeen` (ARCHITECTURE §7).
 */
export const ALERT_SUPPRESSION_WINDOW_MS = 15 * 60 * 1000;

/** At most this many contributing events are linked to one alert (ARCHITECTURE §2.3, §7). */
export const MAX_ALERT_EVENTS = 100;

export const ALERT_STATUSES = ['new', 'acknowledged', 'closed'] as const;
export const alertStatusSchema = z.enum(ALERT_STATUSES);
export type AlertStatus = z.infer<typeof alertStatusSchema>;

export const RESOLUTIONS = ['true_positive', 'false_positive', 'benign'] as const;
export const resolutionSchema = z.enum(RESOLUTIONS);
export type Resolution = z.infer<typeof resolutionSchema>;

export const RULE_TYPES = ['sigma', 'correlation'] as const;
export const ruleTypeSchema = z.enum(RULE_TYPES);
export type RuleType = z.infer<typeof ruleTypeSchema>;

export const LICENSES = ['DRL-1.1', 'MIT'] as const;
export const licenseSchema = z.enum(LICENSES);
export type License = z.infer<typeof licenseSchema>;

/** ATT&CK technique or sub-technique id, e.g. `T1110` or `T1110.001`. */
export const techniqueIdSchema = z.string().regex(/^T\d{4}(?:\.\d{3})?$/);

export const entitiesSchema = z.object({
  ips: z.array(ipAddressSchema),
  users: z.array(z.string()),
  hosts: z.array(z.string()),
});
export type Entities = z.infer<typeof entitiesSchema>;

export const alertSchema = z.object({
  id: z.uuid(),
  ruleId: z.string().min(1),
  ruleTitle: z.string().min(1),
  ruleType: ruleTypeSchema,
  level: levelSchema,
  status: alertStatusSchema,
  resolution: resolutionSchema.nullable(),
  note: z.string().nullable(),
  dedupKey: z.string().min(1),
  groupKey: z.string().nullable(),
  host: z.string().nullable(),
  techniques: z.array(techniqueIdSchema),
  tactics: z.array(z.string().min(1)),
  entities: entitiesSchema,
  firstSeen: utcTimestampSchema,
  lastSeen: utcTimestampSchema,
  count: z.number().int().min(1),
  author: z.string().nullable(),
  ruleUrl: z.url().nullable(),
  license: licenseSchema.nullable(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export type Alert = z.infer<typeof alertSchema>;
