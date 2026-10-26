/**
 * PostgreSQL `AlertSink` (ARCHITECTURE §2.3, §7) with the same deduplication and
 * suppression rules as the in-memory sink (S0-08):
 *
 * - a candidate folds into the open (`new` or `acknowledged`) alert with the same dedup
 *   key that was seen last, when `candidate.firstSeen - alert.lastSeen <= 15 minutes`
 *   (overlaps fold too): `count` + 1, `firstSeen`/`lastSeen` widened, entities merged,
 *   events linked (at most 100 per alert);
 * - otherwise it creates a new alert.
 *
 * One `upsert` call is one transaction. A transaction-level advisory lock serializes
 * sinks across processes (the server and `npm run ingest` or `npm run demo` writing to
 * the same database), and `SELECT ... FOR UPDATE` on the open alerts makes a concurrent
 * triage (closing an alert) either wait for the fold or be seen by it. Candidates are
 * applied in memory, in order, then written with one statement per kind of change.
 */
import {
  ALERT_SUPPRESSION_WINDOW_MS,
  MAX_ALERT_EVENTS,
  type Alert,
  type Entities,
} from '@centinela/shared';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { AlertCandidate, AlertSink } from '../pipeline/types.js';
import { ALERT_COLUMNS, alertFromRow, alertToRecord, type AlertRow } from './rows.js';
import { withTransaction } from './sql.js';

/** Key of the advisory lock every alert sink takes (any constant bigint works). */
export const ALERT_SINK_LOCK_KEY = 0x63656e74696e656cn; // "centinel" in ASCII

/**
 * Each entity list keeps at most this many values: IPs and user names are attacker-chosen
 * and must not grow an alert row without bound.
 */
export const MAX_ENTITY_VALUES = 100;

export interface PgAlertSinkOptions {
  /** Wall clock for `createdAt`/`updatedAt` (record keeping only, never detection). */
  now?: () => Date;
  newId?: () => string;
}

/** An alert being changed by the current `upsert` call. */
interface Working {
  alert: Alert;
  /** Created in this call (inserted at the end) rather than loaded. */
  isNew: boolean;
  /** Event ids linked to the alert, at most `MAX_ALERT_EVENTS`. */
  linked: Set<string>;
  /** Links added in this call. */
  added: string[];
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].slice(0, MAX_ENTITY_VALUES);
}

function mergeEntities(a: Entities, b: Entities): Entities {
  return {
    ips: union(a.ips, b.ips),
    users: union(a.users, b.users),
    hosts: union(a.hosts, b.hosts),
  };
}

const iso = (value: string) => new Date(value).toISOString();
const earliest = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
const latest = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

function link(working: Working, eventIds: readonly string[]): void {
  for (const id of eventIds) {
    if (working.linked.size >= MAX_ALERT_EVENTS) return;
    if (working.linked.has(id)) continue;
    working.linked.add(id);
    working.added.push(id);
  }
}

/** The open alert seen last for each dedup key, locked until the transaction ends. */
async function loadOpenAlerts(
  client: PoolClient,
  dedupKeys: readonly string[],
): Promise<Map<string, Working>> {
  const { rows } = await client.query<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM alerts a
      WHERE a.dedup_key = ANY($1::text[]) AND a.status <> 'closed'
      ORDER BY a.last_seen DESC, a.id DESC
      FOR UPDATE`,
    [dedupKeys],
  );
  const open = new Map<string, Working>();
  for (const row of rows) {
    if (open.has(row.dedup_key)) continue;
    open.set(row.dedup_key, {
      alert: alertFromRow(row),
      isNew: false,
      linked: new Set(),
      added: [],
    });
  }
  if (open.size > 0) {
    const ids = [...open.values()].map((w) => w.alert.id);
    const links = await client.query<{ alert_id: string; event_id: string }>(
      'SELECT alert_id, event_id FROM alert_events WHERE alert_id = ANY($1::uuid[])',
      [ids],
    );
    const byId = new Map([...open.values()].map((w) => [w.alert.id, w]));
    for (const { alert_id, event_id } of links.rows) byId.get(alert_id)?.linked.add(event_id);
  }
  return open;
}

const INSERT_ALERTS = `
INSERT INTO alerts (
  id, rule_id, rule_title, rule_type, level, status, resolution, note, dedup_key, group_key,
  host, techniques, tactics, entities, first_seen, last_seen, count, author, rule_url,
  license, created_at, updated_at
)
SELECT
  id, rule_id, rule_title, rule_type, level, status, resolution, note, dedup_key, group_key,
  host, techniques, tactics, entities, first_seen, last_seen, count, author, rule_url,
  license, created_at, updated_at
FROM jsonb_to_recordset($1::jsonb) AS r(
  id uuid, rule_id text, rule_title text, rule_type text, level text, status text,
  resolution text, note text, dedup_key text, group_key text, host text, techniques text[],
  tactics text[], entities jsonb, first_seen timestamptz, last_seen timestamptz,
  count integer, author text, rule_url text, license text, created_at timestamptz,
  updated_at timestamptz
)`;

const UPDATE_ALERTS = `
UPDATE alerts AS a
   SET count = r.count, first_seen = r.first_seen, last_seen = r.last_seen,
       entities = r.entities, updated_at = r.updated_at
  FROM jsonb_to_recordset($1::jsonb) AS r(
    id uuid, count integer, first_seen timestamptz, last_seen timestamptz, entities jsonb,
    updated_at timestamptz
  )
 WHERE a.id = r.id`;

const INSERT_LINKS = `
INSERT INTO alert_events (alert_id, event_id)
SELECT * FROM unnest($1::uuid[], $2::uuid[])
ON CONFLICT DO NOTHING`;

export function createPgAlertSink(pool: Pool, options: PgAlertSinkOptions = {}): AlertSink {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => uuidv7());

  function create(candidate: AlertCandidate, timestamp: string): Working {
    const { rule } = candidate;
    const working: Working = {
      alert: {
        id: newId(),
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleType: rule.type,
        level: rule.level,
        status: 'new',
        resolution: null,
        note: null,
        dedupKey: candidate.dedupKey,
        groupKey: candidate.groupKey,
        host: candidate.host,
        techniques: [...rule.techniques],
        tactics: [...rule.tactics],
        entities: mergeEntities({ ips: [], users: [], hosts: [] }, candidate.entities),
        firstSeen: iso(candidate.firstSeen),
        lastSeen: iso(candidate.lastSeen),
        count: 1,
        author: rule.author,
        ruleUrl: rule.url,
        license: rule.license,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      isNew: true,
      linked: new Set(),
      added: [],
    };
    link(working, candidate.eventIds);
    return working;
  }

  function fold(working: Working, candidate: AlertCandidate, timestamp: string): void {
    const { alert } = working;
    working.alert = {
      ...alert,
      count: alert.count + 1,
      firstSeen: earliest(alert.firstSeen, iso(candidate.firstSeen)),
      lastSeen: latest(alert.lastSeen, iso(candidate.lastSeen)),
      entities: mergeEntities(alert.entities, candidate.entities),
      updatedAt: timestamp,
    };
    link(working, candidate.eventIds);
  }

  function canFold(working: Working | undefined, candidate: AlertCandidate): working is Working {
    if (!working || working.alert.status === 'closed') return false;
    const gap = Date.parse(candidate.firstSeen) - Date.parse(working.alert.lastSeen);
    return gap <= ALERT_SUPPRESSION_WINDOW_MS;
  }

  async function write(client: PoolClient, touched: readonly Working[]): Promise<void> {
    const inserted = touched.filter((w) => w.isNew).map((w) => alertToRecord(w.alert));
    const updated = touched
      .filter((w) => !w.isNew)
      .map(({ alert }) => ({
        id: alert.id,
        count: alert.count,
        first_seen: alert.firstSeen,
        last_seen: alert.lastSeen,
        entities: alert.entities,
        updated_at: alert.updatedAt,
      }));
    if (inserted.length > 0) await client.query(INSERT_ALERTS, [JSON.stringify(inserted)]);
    if (updated.length > 0) await client.query(UPDATE_ALERTS, [JSON.stringify(updated)]);
    const alertIds: string[] = [];
    const eventIds: string[] = [];
    for (const working of touched) {
      for (const eventId of working.added) {
        alertIds.push(working.alert.id);
        eventIds.push(eventId);
      }
    }
    if (alertIds.length > 0) await client.query(INSERT_LINKS, [alertIds, eventIds]);
  }

  return {
    async upsert(candidates) {
      if (candidates.length === 0) return { created: [], updated: [] };
      const timestamp = now().toISOString();
      return withTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [ALERT_SINK_LOCK_KEY.toString()]);
        const dedupKeys = [...new Set(candidates.map((c) => c.dedupKey))];
        const current = await loadOpenAlerts(client, dedupKeys);
        /** Every alert this call changes, in order of first change (Set keeps insertion order). */
        const touched = new Set<Working>();
        for (const candidate of candidates) {
          const working = current.get(candidate.dedupKey);
          if (canFold(working, candidate)) {
            fold(working, candidate, timestamp);
            touched.add(working);
          } else {
            const created = create(candidate, timestamp);
            current.set(candidate.dedupKey, created);
            touched.add(created);
          }
        }
        await write(client, [...touched]);
        const all = [...touched];
        return {
          created: all.filter((w) => w.isNew).map((w) => w.alert),
          updated: all.filter((w) => !w.isNew).map((w) => w.alert),
        };
      });
    },
  };
}
