/**
 * Audit log of analyst actions (`audit_log`): sign-ins and failed sign-ins, lockouts,
 * sign-outs, alert triage, rule changes, ingest token changes and dashboard uploads.
 *
 * Rows are only inserted, never updated or deleted by the application. Writers pass the
 * client of the transaction that makes the change when there is one, so the change and its
 * audit row commit together. Rows are ordered by `seq`, a database identity that increases
 * with every insert: several rows can share the same `at` millisecond (a failed sign-in and
 * the lockout it triggers), and their UUIDs carry no order within a millisecond (S6-17).
 */
import { auditEntrySchema, type AuditAction, type AuditEntry, type Page } from '@centinela/shared';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
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
      uuidv7(),
      at.toISOString(),
      record.actor?.slice(0, MAX_AUDIT_TEXT) ?? null,
      record.action,
      record.target?.slice(0, MAX_AUDIT_TEXT) ?? null,
      record.ip ?? null,
      JSON.stringify(record.details ?? {}),
    ],
  );
}

/** Keyset cursor of the audit log: base64url of the last row's `seq`. */
export function encodeAuditCursor(seq: string): string {
  return Buffer.from(seq, 'utf8').toString('base64url');
}

/** The `seq` in a cursor, or undefined when the server did not produce it. */
export function decodeAuditCursor(cursor: string): string | undefined {
  const seq = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^[1-9]\d{0,18}$/.test(seq) ? seq : undefined;
}

export interface AuditFilter {
  actions?: readonly AuditAction[];
  /** `seq` of the last row already seen (from `decodeAuditCursor`). */
  afterSeq?: string;
  limit: number;
}

interface AuditRow {
  /** bigint, returned as text by pg. */
  seq: string;
  id: string;
  at: Date;
  actor: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  details: unknown;
}

/** Newest first, in insertion order (`seq`), keyset-paginated. */
export async function listAudit(pool: Pool, filter: AuditFilter): Promise<Page<AuditEntry>> {
  const params = new SqlParams();
  const conditions: string[] = [];
  if (filter.actions) conditions.push(`action = ANY(${params.add(filter.actions)}::text[])`);
  if (filter.afterSeq !== undefined)
    conditions.push(`seq < ${params.add(filter.afterSeq)}::bigint`);
  const { rows } = await pool.query<AuditRow>(
    `SELECT seq, id, at, actor, action, target, host(ip) AS ip, details
       FROM audit_log
       ${whereClause(conditions)}
      ORDER BY seq DESC
      LIMIT ${params.add(filter.limit + 1)}`,
    params.values,
  );
  const page = rows.slice(0, filter.limit);
  const items = page.map((row) =>
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
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > filter.limit && last ? encodeAuditCursor(last.seq) : null,
  };
}
