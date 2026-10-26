/**
 * In-memory `AlertSink` with the deduplication and suppression rules of ARCHITECTURE §7.
 * The default when the pipeline has no database pool (tests); `src/db/alert-sink.ts` is the
 * PostgreSQL sink with the same rules.
 */
import {
  ALERT_SUPPRESSION_WINDOW_MS,
  MAX_ALERT_EVENTS,
  type Alert,
  type Entities,
} from '@centinela/shared';
import { v7 as uuidv7 } from 'uuid';
import type { AlertCandidate, AlertSink } from './types.js';

export interface MemoryAlertSink extends AlertSink {
  /** Every alert, oldest first. */
  list(): Alert[];
  /** Event ids linked to an alert, oldest first (at most 100). */
  eventIds(alertId: string): string[];
}

export interface MemoryAlertSinkOptions {
  /** Wall clock for `createdAt`/`updatedAt` (record keeping only, never detection). */
  now?: () => Date;
  newId?: () => string;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function mergeEntities(a: Entities, b: Entities): Entities {
  return {
    ips: union(a.ips, b.ips),
    users: union(a.users, b.users),
    hosts: union(a.hosts, b.hosts),
  };
}

function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function createMemoryAlertSink(options: MemoryAlertSinkOptions = {}): MemoryAlertSink {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => uuidv7());
  const alerts = new Map<string, Alert>();
  const links = new Map<string, string[]>();
  /** dedupKey → id of the most recent alert with that key. */
  const latestByDedupKey = new Map<string, string>();

  function openAlertFor(candidate: AlertCandidate): Alert | undefined {
    const id = latestByDedupKey.get(candidate.dedupKey);
    const alert = id === undefined ? undefined : alerts.get(id);
    if (!alert || alert.status === 'closed') return undefined;
    const gap = Date.parse(candidate.firstSeen) - Date.parse(alert.lastSeen);
    return gap <= ALERT_SUPPRESSION_WINDOW_MS ? alert : undefined;
  }

  function create(candidate: AlertCandidate, timestamp: string): Alert {
    const { rule } = candidate;
    const alert: Alert = {
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
      firstSeen: candidate.firstSeen,
      lastSeen: candidate.lastSeen,
      count: 1,
      author: rule.author,
      ruleUrl: rule.url,
      license: rule.license,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    alerts.set(alert.id, alert);
    links.set(alert.id, candidate.eventIds.slice(0, MAX_ALERT_EVENTS));
    latestByDedupKey.set(alert.dedupKey, alert.id);
    return alert;
  }

  function fold(alert: Alert, candidate: AlertCandidate, timestamp: string): Alert {
    const updated: Alert = {
      ...alert,
      count: alert.count + 1,
      firstSeen: minIso(alert.firstSeen, candidate.firstSeen),
      lastSeen: maxIso(alert.lastSeen, candidate.lastSeen),
      entities: mergeEntities(alert.entities, candidate.entities),
      updatedAt: timestamp,
    };
    alerts.set(updated.id, updated);
    const linked = links.get(updated.id) ?? [];
    links.set(updated.id, union(linked, candidate.eventIds).slice(0, MAX_ALERT_EVENTS));
    return updated;
  }

  return {
    upsert(candidates) {
      const timestamp = now().toISOString();
      const createdIds: string[] = [];
      const updatedIds: string[] = [];
      for (const candidate of candidates) {
        const open = openAlertFor(candidate);
        if (open) {
          fold(open, candidate, timestamp);
          if (!createdIds.includes(open.id) && !updatedIds.includes(open.id))
            updatedIds.push(open.id);
        } else {
          createdIds.push(create(candidate, timestamp).id);
        }
      }
      const pick = (ids: string[]) =>
        ids.map((id) => alerts.get(id)).filter((a): a is Alert => a !== undefined);
      return Promise.resolve({ created: pick(createdIds), updated: pick(updatedIds) });
    },
    list: () => [...alerts.values()],
    eventIds: (alertId) => [...(links.get(alertId) ?? [])],
  };
}
