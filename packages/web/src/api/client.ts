/**
 * Typed API client. Every response is parsed with the shared zod schemas, so a contract
 * mismatch fails loudly instead of rendering bad data. Errors carry the server's
 * problem+json body when there is one.
 */
import {
  alertBulkResponseSchema,
  alertDetailResponseSchema,
  alertSchema,
  alertsPageSchema,
  attackResponseSchema,
  eventsPageSchema,
  healthResponseSchema,
  ingestSummarySchema,
  normalizedEventSchema,
  problemSchema,
  ruleDetailResponseSchema,
  ruleMetaSchema,
  rulesPageSchema,
  statsOverviewResponseSchema,
  type AlertBulkBody,
  type AlertPatchBody,
  type IngestQuery,
  type Problem,
  type RulePatchBody,
} from '@centinela/shared';
import type { z } from 'zod';

export const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | undefined,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;
export type QueryParams = Readonly<Record<string, QueryValue>>;

/** Query string from a params object; empty values are dropped, arrays become `a,b`. */
export function toSearchParams(params: QueryParams = {}): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  return search;
}

function apiUrl(path: string, params?: QueryParams): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  url.search = toSearchParams(params).toString();
  return url.toString();
}

async function readJson(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return undefined;
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  params?: QueryParams;
  json?: unknown;
  text?: string;
  signal?: AbortSignal;
}

export async function apiRequest<T extends z.ZodType>(
  path: string,
  schema: T,
  options: RequestOptions = {},
): Promise<z.infer<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.text !== undefined) {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    body = options.text;
  }
  const res = await fetch(apiUrl(path, options.params), {
    method: options.method ?? 'GET',
    headers,
    body,
    credentials: 'same-origin',
    signal: options.signal,
  });
  const data = await readJson(res);
  if (!res.ok) {
    const problem = problemSchema.safeParse(data);
    throw new ApiError(res.status, problem.success ? problem.data : undefined);
  }
  return schema.parse(data);
}

const enc = encodeURIComponent;

/** One function per endpoint in ARCHITECTURE §9 (ingest from agents excluded: it needs a token). */
export const api = {
  health: (signal?: AbortSignal) =>
    // 503 still carries a health body; surface it instead of throwing.
    apiRequest('/health', healthResponseSchema, { signal }).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 503) {
        return { status: 'degraded', db: 'down', version: 'unknown' } as const;
      }
      throw err;
    }),
  listEvents: (params?: QueryParams, signal?: AbortSignal) =>
    apiRequest('/events', eventsPageSchema, { params, signal }),
  getEvent: (id: string, signal?: AbortSignal) =>
    apiRequest(`/events/${enc(id)}`, normalizedEventSchema, { signal }),
  listAlerts: (params?: QueryParams, signal?: AbortSignal) =>
    apiRequest('/alerts', alertsPageSchema, { params, signal }),
  getAlert: (id: string, signal?: AbortSignal) =>
    apiRequest(`/alerts/${enc(id)}`, alertDetailResponseSchema, { signal }),
  updateAlert: (id: string, body: AlertPatchBody) =>
    apiRequest(`/alerts/${enc(id)}`, alertSchema, { method: 'PATCH', json: body }),
  bulkUpdateAlerts: (body: AlertBulkBody) =>
    apiRequest('/alerts/bulk', alertBulkResponseSchema, { method: 'POST', json: body }),
  listRules: (params?: QueryParams, signal?: AbortSignal) =>
    apiRequest('/rules', rulesPageSchema, { params, signal }),
  getRule: (id: string, signal?: AbortSignal) =>
    apiRequest(`/rules/${enc(id)}`, ruleDetailResponseSchema, { signal }),
  updateRule: (id: string, body: RulePatchBody) =>
    apiRequest(`/rules/${enc(id)}`, ruleMetaSchema, { method: 'PATCH', json: body }),
  overviewStats: (params?: QueryParams, signal?: AbortSignal) =>
    apiRequest('/stats/overview', statsOverviewResponseSchema, { params, signal }),
  attackMatrix: (params?: QueryParams, signal?: AbortSignal) =>
    apiRequest('/attack', attackResponseSchema, { params, signal }),
  uploadLog: (query: IngestQuery, text: string) =>
    apiRequest('/ingest/upload', ingestSummarySchema, { method: 'POST', params: query, text }),
};
