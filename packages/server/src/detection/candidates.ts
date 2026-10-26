/**
 * Alert candidates (ARCHITECTURE §2.3, §7). Dedup keys:
 *
 * - correlations: `ruleId|groupKey`;
 * - single-event rules: `ruleId|host|entity`, where the entity is the first present of
 *   `source.ip`, `user.name` and `Image`, otherwise empty.
 *
 * Suppression (folding a candidate into an open alert with the same key) is the sink's job.
 */
import type { NormalizedEvent } from '@centinela/shared';
import type { AlertCandidate } from '../pipeline/types.js';
import type { CorrelationFiring, EventRef } from './correlation/state.js';
import type { EventView } from './event-view.js';
import type { CompiledSigmaRule } from './types.js';

/** At most this many values per entity list. */
const MAX_ENTITIES = 100;

export const DEDUP_ENTITY_FIELDS = ['source.ip', 'user.name', 'Image'] as const;

export function eventRef(event: NormalizedEvent, time: number): EventRef {
  return {
    id: event.id,
    ts: event.ts,
    time,
    host: event.host,
    ...(event.srcIp !== undefined && { ip: event.srcIp }),
    ...(event.user !== undefined && { user: event.user }),
  };
}

function pushUnique(list: string[], value: string | undefined): void {
  if (value !== undefined && list.length < MAX_ENTITIES && !list.includes(value)) list.push(value);
}

export function entitiesOf(events: readonly EventRef[]): AlertCandidate['entities'] {
  const entities: AlertCandidate['entities'] = { ips: [], users: [], hosts: [] };
  for (const event of events) {
    pushUnique(entities.ips, event.ip);
    pushUnique(entities.users, event.user);
    pushUnique(entities.hosts, event.host);
  }
  return entities;
}

export function sigmaCandidate(
  rule: CompiledSigmaRule,
  event: NormalizedEvent,
  view: EventView,
  ref: EventRef,
): AlertCandidate {
  let entity = '';
  for (const field of DEDUP_ENTITY_FIELDS) {
    const value = view.text(field);
    if (value !== undefined) {
      entity = value;
      break;
    }
  }
  return {
    rule: rule.info,
    dedupKey: `${rule.meta.id}|${event.host}|${entity}`,
    groupKey: null,
    eventIds: [event.id],
    firstSeen: event.ts,
    lastSeen: event.ts,
    host: event.host,
    entities: entitiesOf([ref]),
  };
}

export function correlationCandidate(firing: CorrelationFiring): AlertCandidate {
  const { rule, events, groupKey } = firing;
  const hosts = new Set(events.map((e) => e.host));
  const [onlyHost] = hosts;
  return {
    rule: rule.info,
    dedupKey: `${rule.meta.id}|${groupKey ?? ''}`,
    groupKey,
    eventIds: events.map((e) => e.id),
    firstSeen: events[0]?.ts ?? new Date(firing.time).toISOString(),
    lastSeen: events[events.length - 1]?.ts ?? new Date(firing.time).toISOString(),
    host: firing.groupValues.get('host.name') ?? (hosts.size === 1 ? (onlyHost ?? null) : null),
    entities: entitiesOf(events),
  };
}
