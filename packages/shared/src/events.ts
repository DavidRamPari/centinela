import { z } from 'zod';

/** Maximum length of `NormalizedEvent.message` (ARCHITECTURE §3.1, §12). */
export const MAX_MESSAGE_LENGTH = 8192;

export const SOURCE_TYPES = ['linux_auth', 'nginx_access', 'apache_access', 'sysmon'] as const;
export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const EVENT_CATEGORIES = [
  'authentication',
  'iam',
  'session',
  'process',
  'web',
  'network',
  'file',
  'other',
] as const;
export const eventCategorySchema = z.enum(EVENT_CATEGORIES);
export type EventCategory = z.infer<typeof eventCategorySchema>;

export const OUTCOMES = ['success', 'failure', 'unknown'] as const;
export const outcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof outcomeSchema>;

/** A Sigma logsource. Keys a rule does not set are ignored when routing (ARCHITECTURE §5.2). */
export const logSourceSchema = z.object({
  product: z.string().min(1).optional(),
  service: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
});
export type LogSource = z.infer<typeof logSourceSchema>;

export const fieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FieldValue = z.infer<typeof fieldValueSchema>;

/** ISO 8601 timestamp in UTC (`Z` suffix), any sub-second precision. */
export const utcTimestampSchema = z.iso.datetime();

/** IPv4 or IPv6 address, normalized (no brackets, no zone). */
export const ipAddressSchema = z.union([z.ipv4(), z.ipv6()]);

export const normalizedEventSchema = z.object({
  id: z.uuid(),
  ts: utcTimestampSchema,
  ingestedAt: utcTimestampSchema,
  source: sourceTypeSchema,
  host: z.string().min(1),
  logsources: z.array(logSourceSchema),
  category: eventCategorySchema,
  action: z.string().min(1),
  outcome: outcomeSchema,
  user: z.string().optional(),
  srcIp: ipAddressSchema.optional(),
  srcPort: z.number().int().min(0).max(65535).optional(),
  message: z.string().max(MAX_MESSAGE_LENGTH),
  fields: z.record(z.string(), fieldValueSchema),
});
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
