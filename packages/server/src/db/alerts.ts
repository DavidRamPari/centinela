/**
 * Alert queries and triage for `GET/PATCH /api/alerts...` (ARCHITECTURE §7, §9). Lists
 * are newest first by `(last_seen, id)`; the time filter applies to `last_seen` (S3-07).
 */
import type { Alert, AlertStatus, Level, Page, Resolution } from '@centinela/shared';
import type { Pool, PoolClient } from 'pg';
import { encodeCursor, type KeysetPosition } from './cursor.js';
import type { TimeRange } from './events-read.js';
import { ALERT_COLUMNS, alertFromRow, type AlertRow } from './rows.js';
import { SqlParams, toCount, whereClause } from './sql.js';

export interface AlertFilter extends TimeRange {
  status?: AlertStatus[] | undefined;
  level?: Level[] | undefined;
  ruleId?: string | undefined;
  /** Exact technique id. */
  technique?: string | undefined;
  /** Case-insensitive. */
  host?: string | undefined;
  /** Matches the alert's entities. */
  ip?: string | undefined;
  user?: string | undefined;
  after?: KeysetPosition | undefined;
  limit: number;
}

export async function listAlerts(pool: Pool, filter: AlertFilter): Promise<Page<Alert>> {
  const params = new SqlParams();
  const conditions = [
    `a.last_seen >= ${params.add(filter.from)}`,
    `a.last_seen <= ${params.add(filter.to)}`,
  ];
  if (filter.status) conditions.push(`a.status = ANY(${params.add(filter.status)}::text[])`);
  if (filter.level) conditions.push(`a.level = ANY(${params.add(filter.level)}::text[])`);
  if (filter.ruleId) conditions.push(`a.rule_id = ${params.add(filter.ruleId)}`);
  if (filter.technique) {
    conditions.push(`a.techniques @> ARRAY[${params.add(filter.technique)}]::text[]`);
  }
  if (filter.host) conditions.push(`lower(a.host) = lower(${params.add(filter.host)})`);
  if (filter.ip) conditions.push(`a.entities -> 'ips' ? ${params.add(filter.ip)}`);
  if (filter.user) conditions.push(`a.entities -> 'users' ? ${params.add(filter.user)}`);
  if (filter.after) {
    conditions.push(
      `(a.last_seen, a.id) < (${params.add(filter.after.ts)}::timestamptz, ${params.add(filter.after.id)}::uuid)`,
    );
  }
  const { rows } = await pool.query<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM alerts a ${whereClause(conditions)}
      ORDER BY a.last_seen DESC, a.id DESC LIMIT ${params.add(filter.limit + 1)}`,
    params.values,
  );
  const items = rows.slice(0, filter.limit).map(alertFromRow);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > filter.limit && last ? encodeCursor({ ts: last.lastSeen, id: last.id }) : null,
  };
}

export async function getAlert(pool: Pool, id: string): Promise<Alert | undefined> {
  const { rows } = await pool.query<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM alerts a WHERE a.id = $1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? undefined : alertFromRow(row);
}

/**
 * Statuses an alert may move from, per target status (ARCHITECTURE §7, S3-09):
 * `new → acknowledged → closed`, closing straight from `new`, and reopening
 * (`closed → new`). Setting the current status again is allowed (it updates the note,
 * or the resolution of a closed alert).
 */
export const ALLOWED_FROM: Readonly<Record<AlertStatus, readonly AlertStatus[]>> = {
  new: ['new', 'closed'],
  acknowledged: ['new', 'acknowledged'],
  closed: ['new', 'acknowledged', 'closed'],
};

export interface TriageChange {
  status: AlertStatus;
  /** Required when closing (the request schema enforces it); cleared otherwise. */
  resolution?: Resolution | null | undefined;
  /** `undefined` keeps the note, `null` clears it. */
  note?: string | null | undefined;
}

export type TriageResult =
  | { ok: true; alert: Alert }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'conflict'; current: AlertStatus };

/** `UPDATE` for a triage change; `idCondition` selects the alerts (its values are in `params`). */
function triageUpdate(params: SqlParams, idCondition: string, change: TriageChange, now: Date) {
  const resolution = change.status === 'closed' ? (change.resolution ?? null) : null;
  const noteSet = change.note === undefined ? '' : `, note = ${params.add(change.note)}::text`;
  return {
    text: `UPDATE alerts a
              SET status = ${params.add(change.status)},
                  resolution = ${params.add(resolution)}${noteSet},
                  updated_at = ${params.add(now)}
            WHERE ${idCondition} AND a.status = ANY(${params.add(ALLOWED_FROM[change.status])}::text[])
        RETURNING ${ALERT_COLUMNS}`,
    values: params.values,
  };
}

/**
 * Apply a triage change to one alert; the transition check and the update are one statement.
 * Pass a transaction client to commit the change together with its audit row (S6).
 */
export async function triageAlert(
  pool: Pool | PoolClient,
  id: string,
  change: TriageChange,
  now: Date = new Date(),
): Promise<TriageResult> {
  const params = new SqlParams();
  const query = triageUpdate(params, `a.id = ${params.add(id)}`, change, now);
  const { rows } = await pool.query<AlertRow>(query.text, query.values);
  const row = rows[0];
  if (row) return { ok: true, alert: alertFromRow(row) };
  const current = await pool.query<{ status: AlertStatus }>(
    'SELECT status FROM alerts WHERE id = $1',
    [id],
  );
  const status = current.rows[0]?.status;
  return status === undefined
    ? { ok: false, reason: 'not-found' }
    : { ok: false, reason: 'conflict', current: status };
}

/**
 * Apply a triage change to many alerts. Unknown ids and alerts whose status does not
 * allow the transition are skipped; the updated alerts are returned.
 */
export async function triageAlerts(
  pool: Pool | PoolClient,
  ids: readonly string[],
  change: TriageChange,
  now: Date = new Date(),
): Promise<Alert[]> {
  const params = new SqlParams();
  const query = triageUpdate(params, `a.id = ANY(${params.add(ids)}::uuid[])`, change, now);
  const { rows } = await pool.query<AlertRow>(query.text, query.values);
  return rows.map(alertFromRow);
}

/** Number of alerts per rule id (the `matches` column of the rules list). */
export async function alertCountsByRule(pool: Pool): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ rule_id: string; count: string }>(
    'SELECT rule_id, count(*) AS count FROM alerts GROUP BY rule_id',
  );
  return new Map(rows.map((row) => [row.rule_id, toCount(row.count)]));
}

/** Alerts per technique id (exact ids) with `last_seen` in the range. */
export async function alertCountsByTechnique(
  pool: Pool,
  range: TimeRange,
): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ technique: string; count: string }>(
    `SELECT t AS technique, count(*) AS count
       FROM alerts a, unnest(a.techniques) AS t
      WHERE a.last_seen >= $1 AND a.last_seen <= $2
      GROUP BY t`,
    [range.from, range.to],
  );
  return new Map(rows.map((row) => [row.technique, toCount(row.count)]));
}
