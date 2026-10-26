/** Alert list filters, read from and written to the URL (ARCHITECTURE §11). */
import {
  ALERT_STATUSES,
  LEVELS,
  techniqueIdSchema,
  type AlertStatus,
  type Level,
} from '@centinela/shared';
import type { QueryParams } from '../../api/client';
import { readListParam, readTextParam } from '../../lib/search-params';
import { rangeQuery, readTimeRange, type TimeRange } from '../../lib/time-range';

export const ALERT_TEXT_FILTERS = ['host', 'ip', 'user', 'technique', 'ruleId'] as const;
export type AlertTextFilter = (typeof ALERT_TEXT_FILTERS)[number];

export interface AlertFilters {
  status: AlertStatus[];
  level: Level[];
  text: Partial<Record<AlertTextFilter, string>>;
  range: TimeRange;
}

export function readAlertFilters(params: URLSearchParams): AlertFilters {
  const text: Partial<Record<AlertTextFilter, string>> = {};
  for (const key of ALERT_TEXT_FILTERS) {
    const value = readTextParam(params, key);
    if (value === undefined) continue;
    if (key === 'technique') {
      const technique = techniqueIdSchema.safeParse(value.toUpperCase());
      if (technique.success) text.technique = technique.data;
    } else {
      text[key] = value;
    }
  }
  return {
    status: readListParam(params, 'status', ALERT_STATUSES),
    level: readListParam(params, 'level', LEVELS),
    text,
    range: readTimeRange(params),
  };
}

export function alertQueryParams(filters: AlertFilters, now = Date.now()): QueryParams {
  return {
    status: filters.status,
    level: filters.level,
    ...filters.text,
    ...rangeQuery(filters.range, now),
    limit: 50,
  };
}
