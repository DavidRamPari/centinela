/**
 * HTTP API contract (ARCHITECTURE §9): request and response schemas shared by the
 * server (validation at the boundary) and the web client (parsing responses).
 *
 * Query-string schemas accept strings and coerce them; use `z.input<typeof schema>`
 * for the shape a client sends and `z.infer<typeof schema>` for what the server gets.
 */
import { z } from 'zod';
import {
  alertSchema,
  alertStatusSchema,
  levelSchema,
  LEVELS,
  ALERT_STATUSES,
  resolutionSchema,
  techniqueIdSchema,
} from './alerts.js';
import { normalizedEventSchema, outcomeSchema, sourceTypeSchema } from './events.js';
import { ruleMetaSchema, ruleOriginSchema } from './rules.js';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_LIMIT)
  .default(DEFAULT_PAGE_LIMIT);

/** Opaque keyset cursor: base64url of `ts|id`, produced by the server. */
export const cursorSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'cursor must be base64url');

/** ISO 8601 timestamp with `Z` or an explicit offset, as accepted in query strings. */
export const isoTimestampParamSchema = z.iso.datetime({ offset: true });

/** `"true"` / `"false"` in a query string (`z.coerce.boolean` would turn "false" into true). */
export const queryBooleanSchema = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Short free-form filter value from a query string. */
const filterStringSchema = z.string().trim().min(1).max(256);

/**
 * A comma-separated list (or repeated parameter) of enum values, e.g. `level=high,critical`.
 * Always yields a non-empty, de-duplicated array.
 */
export function csvEnumSchema<const T extends readonly [string, ...string[]]>(values: T) {
  const item = z.enum(values);
  return z
    .union([z.string(), z.array(z.string())])
    .transform((raw) =>
      (Array.isArray(raw) ? raw : [raw])
        .flatMap((part) => part.split(','))
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item).min(1))
    .transform((items) => [...new Set(items)]);
}

/** `from`/`to` filters; the server defaults to the last 24 hours when absent. */
export const timeRangeQuerySchema = z.object({
  from: isoTimestampParamSchema.optional(),
  to: isoTimestampParamSchema.optional(),
});

function fromNotAfterTo(value: { from?: string | undefined; to?: string | undefined }): boolean {
  return (
    value.from === undefined ||
    value.to === undefined ||
    Date.parse(value.from) <= Date.parse(value.to)
  );
}
const fromNotAfterToMessage = { message: '`from` must not be after `to`', path: ['from'] };

/** A page of a keyset-paginated list. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.nullable(),
  });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Path parameter for events and alerts (UUIDv7). */
export const uuidParamsSchema = z.object({ id: z.uuid() });
/** Path parameter for rules (Sigma ids are any 8-4-4-4-12 hex id). */
export const ruleIdParamsSchema = z.object({ id: z.guid() });

// ---------------------------------------------------------------------------
// Errors: application/problem+json (RFC 9457)
// ---------------------------------------------------------------------------

export const problemSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof problemSchema>;

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'down']),
  version: z.string().min(1),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/ingest and POST /api/ingest/upload
// ---------------------------------------------------------------------------

function isIanaTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const ingestQuerySchema = z.object({
  source: sourceTypeSchema,
  /** Default host for lines that do not carry one (web access logs). */
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+$/, 'host may contain letters, digits, ".", "_" and "-"')
    .default('unknown'),
  /** IANA zone for timestamps without an offset (RFC 3164 syslog). */
  tz: z
    .string()
    .max(64)
    .refine(isIanaTimeZone, { message: 'unknown IANA time zone' })
    .default('UTC'),
});
export type IngestQuery = z.infer<typeof ingestQuerySchema>;

export const ingestSummarySchema = z.object({
  accepted: z.number().int().min(0),
  rejected: z.number().int().min(0),
  /** First 20 rejected lines (1-based line numbers). */
  rejections: z.array(z.object({ line: z.number().int().min(1), reason: z.string() })).max(20),
  alertsCreated: z.number().int().min(0),
  alertsUpdated: z.number().int().min(0),
  durationMs: z.number().min(0),
});
export type IngestSummary = z.infer<typeof ingestSummarySchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const eventsQuerySchema = timeRangeQuerySchema
  .extend({
    source: sourceTypeSchema.optional(),
    host: filterStringSchema.optional(),
    user: filterStringSchema.optional(),
    ip: filterStringSchema.optional(),
    action: filterStringSchema.optional(),
    outcome: outcomeSchema.optional(),
    /** Full-text search on `message`. */
    q: filterStringSchema.optional(),
    cursor: cursorSchema.optional(),
    limit: limitSchema,
  })
  .refine(fromNotAfterTo, fromNotAfterToMessage);
export type EventsQuery = z.infer<typeof eventsQuerySchema>;

export const eventsPageSchema = pageSchema(normalizedEventSchema);
export type EventsPage = z.infer<typeof eventsPageSchema>;

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const alertsQuerySchema = timeRangeQuerySchema
  .extend({
    status: csvEnumSchema(ALERT_STATUSES).optional(),
    level: csvEnumSchema(LEVELS).optional(),
    ruleId: filterStringSchema.optional(),
    technique: techniqueIdSchema.optional(),
    host: filterStringSchema.optional(),
    ip: filterStringSchema.optional(),
    user: filterStringSchema.optional(),
    cursor: cursorSchema.optional(),
    limit: limitSchema,
  })
  .refine(fromNotAfterTo, fromNotAfterToMessage);
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

export const alertsPageSchema = pageSchema(alertSchema);
export type AlertsPage = z.infer<typeof alertsPageSchema>;

export const MAX_ALERT_DETAIL_EVENTS = 100;

export const alertDetailResponseSchema = z.object({
  alert: alertSchema,
  /** Null when the rule is no longer loaded (for example, removed from `rules/`). */
  rule: ruleMetaSchema.nullable(),
  events: z.array(normalizedEventSchema).max(MAX_ALERT_DETAIL_EVENTS),
});
export type AlertDetailResponse = z.infer<typeof alertDetailResponseSchema>;

export const MAX_NOTE_LENGTH = 4000;

interface TriageFields {
  status: z.infer<typeof alertStatusSchema>;
  resolution?: z.infer<typeof resolutionSchema> | null | undefined;
}
/** Closing requires a resolution; other statuses must not carry one (ARCHITECTURE §7). */
function resolutionMatchesStatus(value: TriageFields, ctx: z.RefinementCtx): void {
  const hasResolution = value.resolution !== undefined && value.resolution !== null;
  if (value.status === 'closed' && !hasResolution) {
    ctx.addIssue({
      code: 'custom',
      message: 'closing an alert requires a resolution',
      path: ['resolution'],
    });
  }
  if (value.status !== 'closed' && hasResolution) {
    ctx.addIssue({
      code: 'custom',
      message: 'a resolution is only allowed when closing',
      path: ['resolution'],
    });
  }
}

export const alertPatchBodySchema = z
  .strictObject({
    status: alertStatusSchema,
    resolution: resolutionSchema.nullable().optional(),
    note: z.string().max(MAX_NOTE_LENGTH).nullable().optional(),
  })
  .superRefine(resolutionMatchesStatus);
export type AlertPatchBody = z.infer<typeof alertPatchBodySchema>;

export const MAX_BULK_IDS = 500;

export const alertBulkBodySchema = z
  .strictObject({
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    status: alertStatusSchema,
    resolution: resolutionSchema.nullable().optional(),
  })
  .superRefine(resolutionMatchesStatus);
export type AlertBulkBody = z.infer<typeof alertBulkBodySchema>;

export const alertBulkResponseSchema = z.object({ updated: z.number().int().min(0) });
export type AlertBulkResponse = z.infer<typeof alertBulkResponseSchema>;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const rulesQuerySchema = z.object({
  q: filterStringSchema.optional(),
  level: csvEnumSchema(LEVELS).optional(),
  technique: techniqueIdSchema.optional(),
  origin: ruleOriginSchema.optional(),
  supported: queryBooleanSchema.optional(),
  enabled: queryBooleanSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: limitSchema,
});
export type RulesQuery = z.infer<typeof rulesQuerySchema>;

export const ruleListItemSchema = ruleMetaSchema.extend({
  /** Number of alerts the rule produced. */
  matches: z.number().int().min(0),
});
export type RuleListItem = z.infer<typeof ruleListItemSchema>;

export const rulesPageSchema = pageSchema(ruleListItemSchema);
export type RulesPage = z.infer<typeof rulesPageSchema>;

export const ruleDetailResponseSchema = z.object({
  rule: ruleMetaSchema,
  /** The rule's YAML source text. */
  source: z.string(),
});
export type RuleDetailResponse = z.infer<typeof ruleDetailResponseSchema>;

export const rulePatchBodySchema = z.strictObject({ enabled: z.boolean() });
export type RulePatchBody = z.infer<typeof rulePatchBodySchema>;

// ---------------------------------------------------------------------------
// GET /api/stats/overview
// ---------------------------------------------------------------------------

export const BUCKETS = ['5m', '1h', '1d'] as const;
export const bucketSchema = z.enum(BUCKETS);
export type Bucket = z.infer<typeof bucketSchema>;

export const statsOverviewQuerySchema = timeRangeQuerySchema
  .extend({ bucket: bucketSchema.default('1h') })
  .refine(fromNotAfterTo, fromNotAfterToMessage);
export type StatsOverviewQuery = z.infer<typeof statsOverviewQuerySchema>;

const countSchema = z.number().int().min(0);
const timeBucketSchema = z.object({ t: z.iso.datetime(), count: countSchema });

export const statsOverviewResponseSchema = z.object({
  events: countSchema,
  alerts: z.object({
    total: countSchema,
    byLevel: z.record(levelSchema, countSchema),
    byStatus: z.record(alertStatusSchema, countSchema),
  }),
  eventsOverTime: z.array(timeBucketSchema),
  alertsOverTime: z.array(timeBucketSchema),
  topSourceIps: z.array(z.object({ ip: z.string(), count: countSchema })),
  topUsers: z.array(z.object({ user: z.string(), count: countSchema })),
  topRules: z.array(
    z.object({ ruleId: z.string(), title: z.string(), level: levelSchema, count: countSchema }),
  ),
});
export type StatsOverviewResponse = z.infer<typeof statsOverviewResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/attack
// ---------------------------------------------------------------------------

export const attackQuerySchema = timeRangeQuerySchema.refine(fromNotAfterTo, fromNotAfterToMessage);
export type AttackQuery = z.infer<typeof attackQuerySchema>;

export const attackResponseSchema = z.object({
  tactics: z.array(
    z.object({
      id: z.string().regex(/^TA\d{4}$/),
      shortname: z.string().min(1),
      name: z.string().min(1),
      techniques: z.array(
        z.object({
          id: techniqueIdSchema,
          name: z.string().min(1),
          url: z.url(),
          /** Supported, enabled rules that map to the technique. */
          rules: countSchema,
          /** Alerts in the time range that map to the technique. */
          alerts: countSchema,
        }),
      ),
    }),
  ),
});
export type AttackResponse = z.infer<typeof attackResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/stream (Server-Sent Events)
// ---------------------------------------------------------------------------

export const ALERT_CHANGE_TYPES = ['alert.created', 'alert.updated'] as const;
export const alertChangeSchema = z.object({
  type: z.enum(ALERT_CHANGE_TYPES),
  alert: alertSchema,
});
export type AlertChange = z.infer<typeof alertChangeSchema>;
