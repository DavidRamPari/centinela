/** Event search filters, read from and written to the URL (ARCHITECTURE §11). */
import { OUTCOMES, SOURCE_TYPES, type Outcome, type SourceType } from '@centinela/shared';
import type { QueryParams } from '../../api/client';
import { readTextParam } from '../../lib/search-params';
import { rangeQuery, readTimeRange, type TimeRange } from '../../lib/time-range';

export const EVENT_TEXT_FILTERS = ['host', 'user', 'ip', 'action', 'q'] as const;
export type EventTextFilter = (typeof EVENT_TEXT_FILTERS)[number];

export interface EventFilters {
  source: SourceType | undefined;
  outcome: Outcome | undefined;
  text: Partial<Record<EventTextFilter, string>>;
  range: TimeRange;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

export function readEventFilters(params: URLSearchParams): EventFilters {
  const text: Partial<Record<EventTextFilter, string>> = {};
  for (const key of EVENT_TEXT_FILTERS) {
    const value = readTextParam(params, key);
    if (value !== undefined) text[key] = value;
  }
  return {
    source: oneOf(params.get('source'), SOURCE_TYPES),
    outcome: oneOf(params.get('outcome'), OUTCOMES),
    text,
    range: readTimeRange(params),
  };
}

export function eventQueryParams(filters: EventFilters, now = Date.now()): QueryParams {
  return {
    source: filters.source,
    outcome: filters.outcome,
    ...filters.text,
    ...rangeQuery(filters.range, now),
    limit: 50,
  };
}
