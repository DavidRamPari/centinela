/**
 * In-memory implementations of the API queries over a MockDb, following ARCHITECTURE §9:
 * the same filters, keyset pagination (`ts|id` cursors, newest first) and response shapes
 * the server returns. Inputs are the already-validated query objects from the shared schemas.
 */
import {
  ALERT_STATUSES,
  LEVELS,
  type Alert,
  type AlertsQuery,
  type AttackQuery,
  type AttackResponse,
  type EventsQuery,
  type NormalizedEvent,
  type Page,
  type RuleListItem,
  type RulesQuery,
  type StatsOverviewQuery,
  type StatsOverviewResponse,
} from '@centinela/shared';
import type { MockDb } from './fixtures/build';

const DAY = 24 * 60 * 60 * 1000;
const BUCKET_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000, '1d': DAY } as const;

export function encodeCursor(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): string | undefined {
  try {
    return atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return undefined;
  }
}

/** `from`/`to` with the server defaults: `to` = now, `from` = `to` − 24 h. */
export function resolveRange(query: { from?: string | undefined; to?: string | undefined }) {
  const to = query.to ? Date.parse(query.to) : Date.now();
  const from = query.from ? Date.parse(query.from) : to - DAY;
  return { from, to };
}

function inRange(iso: string, range: { from: number; to: number }): boolean {
  const t = Date.parse(iso);
  return t >= range.from && t <= range.to;
}

/** Keyset page over items sorted newest first by (`key`, id). */
function keysetPage<T extends { id: string }>(
  items: readonly T[],
  key: (item: T) => string,
  cursor: string | undefined,
  limit: number,
): Page<T> {
  let start = 0;
  if (cursor) {
    const [ts = '', id = ''] = (decodeCursor(cursor) ?? '').split('|');
    start = items.findIndex((item) => key(item) < ts || (key(item) === ts && item.id < id));
    if (start === -1) start = items.length;
  }
  const slice = items.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const more = start + limit < items.length;
  return {
    items: slice,
    nextCursor: more && last ? encodeCursor(`${key(last)}|${last.id}`) : null,
  };
}

const lower = (value: string) => value.toLowerCase();

export function listEvents(db: MockDb, query: EventsQuery): Page<NormalizedEvent> {
  const range = resolveRange(query);
  const q = query.q ? lower(query.q) : undefined;
  const matches = db.events.filter(
    (event) =>
      inRange(event.ts, range) &&
      (!query.source || event.source === query.source) &&
      (!query.host || lower(event.host) === lower(query.host)) &&
      (!query.user || event.user === query.user) &&
      (!query.ip || event.srcIp === query.ip) &&
      (!query.action || event.action === query.action) &&
      (!query.outcome || event.outcome === query.outcome) &&
      (!q || lower(event.message).includes(q)),
  );
  return keysetPage(matches, (event) => event.ts, query.cursor, query.limit);
}

function alertMatches(alert: Alert, query: Omit<AlertsQuery, 'limit' | 'cursor'>): boolean {
  const range = resolveRange(query);
  return (
    inRange(alert.lastSeen, range) &&
    (!query.status || query.status.includes(alert.status)) &&
    (!query.level || query.level.includes(alert.level)) &&
    (!query.ruleId || alert.ruleId === query.ruleId) &&
    (!query.technique || alert.techniques.includes(query.technique)) &&
    (!query.host || (alert.host !== null && lower(alert.host) === lower(query.host))) &&
    (!query.ip || alert.entities.ips.includes(query.ip)) &&
    (!query.user || alert.entities.users.includes(query.user))
  );
}

export function listAlerts(db: MockDb, query: AlertsQuery): Page<Alert> {
  const matches = db.alerts.filter((alert) => alertMatches(alert, query));
  return keysetPage(matches, (alert) => alert.lastSeen, query.cursor, query.limit);
}

export function alertDetail(db: MockDb, id: string) {
  const alert = db.alerts.find((a) => a.id === id);
  if (!alert) return undefined;
  const ids = db.alertEvents.get(id) ?? [];
  const events = ids
    .map((eventId) => db.events.find((event) => event.id === eventId))
    .filter((event): event is NormalizedEvent => event !== undefined)
    .slice(0, 100);
  const rule = db.rules.find((r) => r.id === alert.ruleId) ?? null;
  return { alert, rule, events };
}

export function listRules(db: MockDb, query: RulesQuery): Page<RuleListItem> {
  const q = query.q ? lower(query.q) : undefined;
  const matches = db.rules
    .filter(
      (rule) =>
        (!q ||
          [rule.title, rule.name ?? '', rule.description ?? '', rule.id, rule.path].some((text) =>
            lower(text).includes(q),
          )) &&
        (!query.level || query.level.includes(rule.level)) &&
        (!query.technique || rule.techniques.includes(query.technique)) &&
        (!query.origin || rule.origin === query.origin) &&
        (query.supported === undefined || rule.supported === query.supported) &&
        (query.enabled === undefined || rule.enabled === query.enabled),
    )
    .map((rule) => ({
      ...rule,
      matches: db.alerts.filter((alert) => alert.ruleId === rule.id).length,
    }));
  // Rules are ordered by level and title; the cursor is an opaque offset.
  const offset = query.cursor ? Number((decodeCursor(query.cursor) ?? '').replace(/^o:/, '')) : 0;
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const items = matches.slice(start, start + query.limit);
  const end = start + items.length;
  return { items, nextCursor: end < matches.length ? encodeCursor(`o:${end}`) : null };
}

function series(times: readonly string[], range: { from: number; to: number }, size: number) {
  const counts = new Map<number, number>();
  for (const iso of times) {
    const t = Date.parse(iso);
    if (t < range.from || t > range.to) continue;
    const bucket = Math.floor(t / size) * size;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, count]) => ({ t: new Date(t).toISOString(), count }));
}

function top<T extends string>(values: ReadonlyArray<T | undefined>, limit = 10) {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

export function overviewStats(db: MockDb, query: StatsOverviewQuery): StatsOverviewResponse {
  const range = resolveRange(query);
  const events = db.events.filter((event) => inRange(event.ts, range));
  const alerts = db.alerts.filter((alert) => inRange(alert.lastSeen, range));
  const byLevel = Object.fromEntries(
    LEVELS.map((level) => [level, alerts.filter((a) => a.level === level).length]),
  ) as StatsOverviewResponse['alerts']['byLevel'];
  const byStatus = Object.fromEntries(
    ALERT_STATUSES.map((status) => [status, alerts.filter((a) => a.status === status).length]),
  ) as StatsOverviewResponse['alerts']['byStatus'];
  const size = BUCKET_MS[query.bucket];
  const rules = new Map(db.rules.map((rule) => [rule.id, rule]));
  return {
    events: events.length,
    alerts: { total: alerts.length, byLevel, byStatus },
    eventsOverTime: series(
      events.map((e) => e.ts),
      range,
      size,
    ),
    alertsOverTime: series(
      alerts.map((a) => a.lastSeen),
      range,
      size,
    ),
    topSourceIps: top(events.map((e) => e.srcIp)).map(([ip, count]) => ({ ip, count })),
    topUsers: top(events.map((e) => e.user)).map(([user, count]) => ({ user, count })),
    topRules: top(alerts.map((a) => a.ruleId)).map(([ruleId, count]) => {
      const rule = rules.get(ruleId);
      return {
        ruleId,
        title: rule?.title ?? ruleId,
        level: rule?.level ?? 'informational',
        count,
      };
    }),
  };
}

/**
 * ATT&CK matrix: every technique of each tactic (sorted by name, as in the ATT&CK
 * Navigator), with sub-techniques listed after their parent only when they have rules or
 * alerts. Counts use the exact technique id.
 */
export function attackMatrix(db: MockDb, query: AttackQuery): AttackResponse {
  const range = resolveRange(query);
  const ruleCounts = new Map<string, number>();
  for (const rule of db.rules) {
    if (!rule.supported || !rule.enabled) continue;
    for (const id of rule.techniques) ruleCounts.set(id, (ruleCounts.get(id) ?? 0) + 1);
  }
  const alertCounts = new Map<string, number>();
  for (const alert of db.alerts) {
    if (!inRange(alert.lastSeen, range)) continue;
    for (const id of alert.techniques) alertCounts.set(id, (alertCounts.get(id) ?? 0) + 1);
  }
  const entry = (technique: { id: string; name: string; url: string }) => ({
    id: technique.id,
    name: technique.name,
    url: technique.url,
    rules: ruleCounts.get(technique.id) ?? 0,
    alerts: alertCounts.get(technique.id) ?? 0,
  });

  return {
    tactics: db.attack.tactics.map((tactic) => {
      const inTactic = db.attack.techniques.filter((t) => t.tactics.includes(tactic.shortname));
      const parents = inTactic
        .filter((t) => !t.subtechnique)
        .sort((a, b) => a.name.localeCompare(b.name));
      const techniques = parents.flatMap((parent) => [
        entry(parent),
        ...inTactic
          .filter((t) => t.subtechnique && t.id.startsWith(`${parent.id}.`))
          .filter((t) => ruleCounts.has(t.id) || alertCounts.has(t.id))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(entry),
      ]);
      return { id: tactic.id, shortname: tactic.shortname, name: tactic.name, techniques };
    }),
  };
}
