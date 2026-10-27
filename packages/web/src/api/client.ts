/**
 * Typed API client. Every response is parsed with the shared zod schemas, so a contract
 * mismatch fails loudly instead of rendering bad data. Errors carry the server's
 * problem+json body when there is one.
 *
 * Session (S6): the browser sends the session cookie itself (same origin). State-changing
 * requests repeat the CSRF cookie in the `X-CSRF-Token` header (double submit): the
 * `__Host-` cookie, or its unprefixed twin that a development server on plain-HTTP
 * localhost sets instead (the server clears the other one at sign-in). A `401`
 * tells the listeners registered with `onUnauthorized` (the auth gate sends the analyst to
 * the sign-in page).
 */
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  LOCAL_CSRF_COOKIE,
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
    /** Seconds from a `Retry-After` header (rate limits, sign-in lockout). */
    readonly retryAfterSeconds?: number,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

/** The value of a cookie readable by JavaScript, or undefined. */
export function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Called on every `401` answer (session missing or expired); returns an unsubscribe function. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function retryAfter(res: Response): number | undefined {
  const value = Number(res.headers.get('retry-after') ?? '');
  return Number.isFinite(value) && value > 0 ? value : undefined;
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
  /** Default true. False for the sign-in calls, whose `401` is an answer, not a lost session. */
  notifyUnauthorized?: boolean;
}

export async function apiRequest<T extends z.ZodType>(
  path: string,
  schema: T,
  options: RequestOptions = {},
): Promise<z.infer<T>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  const csrf =
    method === 'GET' ? undefined : (readCookie(CSRF_COOKIE) ?? readCookie(LOCAL_CSRF_COOKIE));
  if (csrf) headers[CSRF_HEADER] = csrf;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.text !== undefined) {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    body = options.text;
  }
  const res = await fetch(apiUrl(path, options.params), {
    method,
    headers,
    body,
    credentials: 'same-origin',
    signal: options.signal,
  });
  const data = await readJson(res);
  if (!res.ok) {
    if (res.status === 401 && options.notifyUnauthorized !== false) {
      for (const listener of unauthorizedListeners) listener();
    }
    const problem = problemSchema.safeParse(data);
    throw new ApiError(res.status, problem.success ? problem.data : undefined, retryAfter(res));
  }
  return schema.parse(data);
}

const enc = encodeURIComponent;

/**
 * One function per endpoint in ARCHITECTURE §9 (ingest from agents excluded: it needs a
 * token). Sign-in, tokens and the audit log are in `features/auth/api.ts`.
 */
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
