/**
 * Column lists and row mappers for `events` and `alerts`. Rows are validated with the
 * shared zod schemas on the way out, so the API never returns a value that breaks the
 * contract even if a row was written by hand.
 */
import {
  alertSchema,
  normalizedEventSchema,
  sourceTypeSchema,
  type Alert,
  type NormalizedEvent,
} from '@centinela/shared';
import { logsourcesFor } from './logsources.js';

/** Columns of `events` for `eventFromRow`; `e` is the table alias. */
export const EVENT_COLUMNS = `e.id, e.ts, e.ingested_at, e.source, e.host, e.category, e.action,
  e.outcome, e.user_name, host(e.src_ip) AS src_ip, e.src_port, e.message, e.fields`;

export interface EventRow {
  id: string;
  ts: Date;
  ingested_at: Date;
  source: string;
  host: string;
  category: string;
  action: string;
  outcome: string;
  user_name: string | null;
  src_ip: string | null;
  src_port: number | null;
  message: string;
  fields: unknown;
}

const fieldsSchema = normalizedEventSchema.shape.fields;

export function eventFromRow(row: EventRow): NormalizedEvent {
  const source = sourceTypeSchema.parse(row.source);
  const fields = fieldsSchema.parse(row.fields);
  return normalizedEventSchema.parse({
    id: row.id,
    ts: row.ts.toISOString(),
    ingestedAt: row.ingested_at.toISOString(),
    source,
    host: row.host,
    logsources: logsourcesFor(source, row.action, fields),
    category: row.category,
    action: row.action,
    outcome: row.outcome,
    ...(row.user_name === null ? {} : { user: row.user_name }),
    ...(row.src_ip === null ? {} : { srcIp: row.src_ip }),
    ...(row.src_port === null ? {} : { srcPort: row.src_port }),
    message: row.message,
    fields,
  });
}

/** Columns of `alerts` for `alertFromRow`; `a` is the table alias. */
export const ALERT_COLUMNS = `a.id, a.rule_id, a.rule_title, a.rule_type, a.level, a.status,
  a.resolution, a.note, a.dedup_key, a.group_key, a.host, a.techniques, a.tactics, a.entities,
  a.first_seen, a.last_seen, a.count, a.author, a.rule_url, a.license, a.created_at,
  a.updated_at`;

export interface AlertRow {
  id: string;
  rule_id: string;
  rule_title: string;
  rule_type: string;
  level: string;
  status: string;
  resolution: string | null;
  note: string | null;
  dedup_key: string;
  group_key: string | null;
  host: string | null;
  techniques: string[];
  tactics: string[];
  entities: unknown;
  first_seen: Date;
  last_seen: Date;
  count: number;
  author: string | null;
  rule_url: string | null;
  license: string | null;
  created_at: Date;
  updated_at: Date;
}

export function alertFromRow(row: AlertRow): Alert {
  return alertSchema.parse({
    id: row.id,
    ruleId: row.rule_id,
    ruleTitle: row.rule_title,
    ruleType: row.rule_type,
    level: row.level,
    status: row.status,
    resolution: row.resolution,
    note: row.note,
    dedupKey: row.dedup_key,
    groupKey: row.group_key,
    host: row.host,
    techniques: row.techniques,
    tactics: row.tactics,
    entities: row.entities,
    firstSeen: row.first_seen.toISOString(),
    lastSeen: row.last_seen.toISOString(),
    count: row.count,
    author: row.author,
    ruleUrl: row.rule_url,
    license: row.license,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

/** An alert as the snake_case JSON object `jsonb_to_recordset` reads (see `alert-sink.ts`). */
export function alertToRecord(alert: Alert): Record<string, unknown> {
  return {
    id: alert.id,
    rule_id: alert.ruleId,
    rule_title: alert.ruleTitle,
    rule_type: alert.ruleType,
    level: alert.level,
    status: alert.status,
    resolution: alert.resolution,
    note: alert.note,
    dedup_key: alert.dedupKey,
    group_key: alert.groupKey,
    host: alert.host,
    techniques: alert.techniques,
    tactics: alert.tactics,
    entities: alert.entities,
    first_seen: alert.firstSeen,
    last_seen: alert.lastSeen,
    count: alert.count,
    author: alert.author,
    rule_url: alert.ruleUrl,
    license: alert.license,
    created_at: alert.createdAt,
    updated_at: alert.updatedAt,
  };
}
