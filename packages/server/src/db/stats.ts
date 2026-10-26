/**
 * Numbers for `GET /api/stats/overview` (ARCHITECTURE §9). Events are counted by `ts`,
 * alerts by `last_seen` (as in the alerts list). Time series use `date_bin` aligned to
 * the Unix epoch and contain only non-empty buckets; the dashboard fills the gaps (S3-03).
 */
import {
  alertStatusSchema,
  levelSchema,
  type AlertStatus,
  type Bucket,
  type Level,
  type StatsOverviewResponse,
} from '@centinela/shared';
import type { Pool } from 'pg';
import type { TimeRange } from './events-read.js';
import { toCount } from './sql.js';

export const BUCKET_INTERVALS: Readonly<Record<Bucket, string>> = {
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
};

/** Entries in each top-10 list. */
export const TOP_LIMIT = 10;

const EPOCH = "TIMESTAMPTZ '1970-01-01 00:00:00+00'";

interface SeriesRow {
  t: Date;
  count: string;
}

const toSeries = (rows: SeriesRow[]) =>
  rows.map((r) => ({ t: r.t.toISOString(), count: toCount(r.count) }));

export async function overviewStats(
  pool: Pool,
  range: TimeRange,
  bucket: Bucket,
): Promise<StatsOverviewResponse> {
  const { from, to } = range;
  const interval = BUCKET_INTERVALS[bucket];
  const [events, eventSeries, alertCounts, alertSeries, topIps, topUsers, topRules] =
    await Promise.all([
      pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM events WHERE ts >= $1 AND ts <= $2',
        [from, to],
      ),
      pool.query<SeriesRow>(
        `SELECT date_bin($3::interval, ts, ${EPOCH}) AS t, count(*) AS count
           FROM events WHERE ts >= $1 AND ts <= $2 GROUP BY 1 ORDER BY 1`,
        [from, to, interval],
      ),
      pool.query<{ level: string; status: string; count: string }>(
        `SELECT level, status, count(*) AS count
           FROM alerts WHERE last_seen >= $1 AND last_seen <= $2 GROUP BY level, status`,
        [from, to],
      ),
      pool.query<SeriesRow>(
        `SELECT date_bin($3::interval, last_seen, ${EPOCH}) AS t, count(*) AS count
           FROM alerts WHERE last_seen >= $1 AND last_seen <= $2 GROUP BY 1 ORDER BY 1`,
        [from, to, interval],
      ),
      pool.query<{ ip: string; count: string }>(
        `SELECT host(src_ip) AS ip, count(*) AS count
           FROM events WHERE ts >= $1 AND ts <= $2 AND src_ip IS NOT NULL
          GROUP BY src_ip ORDER BY count(*) DESC, src_ip LIMIT $3`,
        [from, to, TOP_LIMIT],
      ),
      pool.query<{ user_name: string; count: string }>(
        `SELECT user_name, count(*) AS count
           FROM events WHERE ts >= $1 AND ts <= $2 AND user_name IS NOT NULL
          GROUP BY user_name ORDER BY count(*) DESC, user_name LIMIT $3`,
        [from, to, TOP_LIMIT],
      ),
      // Title and level of the rule's most recent alert, in case the rule file changed.
      pool.query<{ rule_id: string; title: string; level: string; count: string }>(
        `SELECT rule_id,
                (array_agg(rule_title ORDER BY last_seen DESC))[1] AS title,
                (array_agg(level ORDER BY last_seen DESC))[1] AS level,
                count(*) AS count
           FROM alerts WHERE last_seen >= $1 AND last_seen <= $2
          GROUP BY rule_id ORDER BY count(*) DESC, rule_id LIMIT $3`,
        [from, to, TOP_LIMIT],
      ),
    ]);

  const byLevel: Record<Level, number> = {
    informational: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  const byStatus: Record<AlertStatus, number> = { new: 0, acknowledged: 0, closed: 0 };
  let total = 0;
  for (const row of alertCounts.rows) {
    const count = toCount(row.count);
    byLevel[levelSchema.parse(row.level)] += count;
    byStatus[alertStatusSchema.parse(row.status)] += count;
    total += count;
  }

  return {
    events: toCount(events.rows[0]?.count),
    alerts: { total, byLevel, byStatus },
    eventsOverTime: toSeries(eventSeries.rows),
    alertsOverTime: toSeries(alertSeries.rows),
    topSourceIps: topIps.rows.map((r) => ({ ip: r.ip, count: toCount(r.count) })),
    topUsers: topUsers.rows.map((r) => ({ user: r.user_name, count: toCount(r.count) })),
    topRules: topRules.rows.map((r) => ({
      ruleId: r.rule_id,
      title: r.title,
      level: levelSchema.parse(r.level),
      count: toCount(r.count),
    })),
  };
}
