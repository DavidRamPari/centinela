/**
 * Audit log of analyst actions (`audit_log`): sign-ins and failed sign-ins, lockouts,
 * sign-outs, alert triage, rule changes, ingest token changes and dashboard uploads.
 *
 * Rows are only inserted, never updated or deleted by the application. Writers pass the
 * client of the transaction that makes the change when there is one, so the change and its
 * audit row commit together. `at` is written from the application clock with millisecond
 * precision so keyset cursors (`at|id`) round-trip exactly.
 */
import { auditEntrySchema, type AuditAction, type AuditEntry, type Page } from '@centinela/shared';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { encodeCursor, type KeysetPosition } from '../db/cursor.js';
import { SqlParams, whereClause } from '../db/sql.js';

export type Queryable = Pool | PoolClient;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface AuditRecord {
  /** Signed-in analyst; for a failed sign-in, the attempted user name. */
  actor: string | null;
  action: AuditAction;
  target?: string | null;
  ip?: string | null;
  details?: Record<string, JsonValue>;
}

/** Attacker-chosen text (attempted user names) is cut before it is stored. */
export const MAX_AUDIT_TEXT = 256;

export async function recordAudit(
  db: Queryable,
  record: AuditRecord,
  at: Date = new Date(),
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (id, at, actor, action, target, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      uuidv7({ msecs: at.getTime() }),
      at.toISOString(),
      record.actor?.slice(0, MAX_AUDIT_TEXT) ?? null,
      record.action,
      record.target?.slice(0, MAX_AUDIT_TEXT) ?? null,
      record.ip ?? null,
      JSON.stringify(record.details ?? {}),
    ],
  );
}

export interface AuditFilter {
  actions?: readonly AuditAction[];
  after?: KeysetPosition;
  limit: number;
}

interface AuditRow {
  id: string;
  at: Date;
  actor: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  details: unknown;
}

/** Newest first by `(at, id)`, keyset-paginated like events and alerts. */
export async function listAudit(pool: Pool, filter: AuditFilter): Promise<Page<AuditEntry>> {
  const params = new SqlParams();
  const conditions: string[] = [];
  if (filter.actions) conditions.push(`action = ANY(${params.add(filter.actions)}::text[])`);
  if (filter.after) {
    conditions.push(
      `(at, id) < (${params.add(filter.after.ts)}::timestamptz, ${params.add(filter.after.id)}::uuid)`,
    );
  }
  const { rows } = await pool.query<AuditRow>(
    `SELECT id, at, actor, action, target, host(ip) AS ip, details
       FROM audit_log
       ${whereClause(conditions)}
      ORDER BY at DESC, id DESC
      LIMIT ${params.add(filter.limit + 1)}`,
    params.values,
  );
  const items = rows.slice(0, filter.limit).map((row) =>
    auditEntrySchema.parse({
      id: row.id,
      at: row.at.toISOString(),
      actor: row.actor,
      action: row.action,
      target: row.target,
      ip: row.ip,
      details: row.details,
    }),
  );
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > filter.limit && last ? encodeCursor({ ts: last.at, id: last.id }) : null,
  };
}
