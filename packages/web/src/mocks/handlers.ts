/**
 * MSW handlers used in tests and when VITE_USE_MOCKS=true. They validate requests with the
 * shared schemas, exactly like the server, so the UI cannot rely on a lenient mock: invalid
 * input gets the same `400` problem+json the real API returns.
 */
import {
  alertBulkBodySchema,
  alertPatchBodySchema,
  alertsQuerySchema,
  attackQuerySchema,
  eventsQuerySchema,
  ingestQuerySchema,
  ruleIdParamsSchema,
  rulePatchBodySchema,
  rulesQuerySchema,
  statsOverviewQuerySchema,
  uuidParamsSchema,
  type HealthResponse,
  type IngestSummary,
  type Problem,
} from '@centinela/shared';
import { http, HttpResponse } from 'msw';
import type { z } from 'zod';
import { createAuthHandlers, resetAuthMock } from '../features/auth/mocks';
import { createMockDb, type MockDb } from './fixtures/build';
import {
  alertDetail,
  attackMatrix,
  listAlerts,
  listEvents,
  listRules,
  overviewStats,
} from './queries';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function problem(status: number, title: string, detail?: string, errors?: Problem['errors']) {
  const body: Problem = {
    type: 'about:blank',
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(errors ? { errors } : {}),
  };
  return HttpResponse.json(body, {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function validationProblem(error: z.ZodError) {
  return problem(
    400,
    'Bad Request',
    'The request is invalid.',
    error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

/** Query string as an object; repeated keys become arrays (as Express parses them). */
function queryObject(request: Request): Record<string, string | string[]> {
  const params = new URL(request.url).searchParams;
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : (values[0] ?? '');
  }
  return out;
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Mock "parser": counts lines that look like the chosen source, rejects the rest. */
export function mockIngest(source: string, text: string): IngestSummary {
  const started = performance.now();
  const lines = text.split('\n');
  const looksValid =
    source === 'linux_auth'
      ? (line: string) => /^\S+\s+\S+\s+\S+[^:]*:/.test(line)
      : source === 'sysmon'
        ? (line: string) => line.trimStart().startsWith('{')
        : (line: string) => /^\S+ \S+ \S+ \[[^\]]+\] "/.test(line);
  let accepted = 0;
  let rejected = 0;
  const rejections: IngestSummary['rejections'] = [];
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    if (looksValid(line)) {
      accepted += 1;
    } else {
      rejected += 1;
      if (rejections.length < 20) {
        rejections.push({
          line: index + 1,
          reason: source === 'linux_auth' ? 'not a syslog line' : 'not an access log line',
        });
      }
    }
  });
  return {
    accepted,
    rejected,
    rejections,
    alertsCreated: 0,
    alertsUpdated: 0,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

export function createHandlers(getDb: () => MockDb) {
  return [
    ...createAuthHandlers(),

    http.get('/api/health', () =>
      HttpResponse.json<HealthResponse>({ status: 'ok', db: 'ok', version: '0.1.0-mock' }),
    ),

    http.get('/api/events', ({ request }) => {
      const query = eventsQuerySchema.safeParse(queryObject(request));
      if (!query.success) return validationProblem(query.error);
      return HttpResponse.json(listEvents(getDb(), query.data));
    }),

    http.get('/api/events/:id', ({ params }) => {
      const parsed = uuidParamsSchema.safeParse(params);
      if (!parsed.success) return validationProblem(parsed.error);
      const event = getDb().events.find((e) => e.id === parsed.data.id);
      return event ? HttpResponse.json(event) : problem(404, 'Not Found', 'No such event.');
    }),

    http.get('/api/alerts', ({ request }) => {
      const query = alertsQuerySchema.safeParse(queryObject(request));
      if (!query.success) return validationProblem(query.error);
      return HttpResponse.json(listAlerts(getDb(), query.data));
    }),

    http.post('/api/alerts/bulk', async ({ request }) => {
      const body = alertBulkBodySchema.safeParse(await jsonBody(request));
      if (!body.success) return validationProblem(body.error);
      const now = new Date().toISOString();
      let updated = 0;
      for (const alert of getDb().alerts) {
        if (!body.data.ids.includes(alert.id)) continue;
        alert.status = body.data.status;
        alert.resolution = body.data.resolution ?? null;
        alert.updatedAt = now;
        updated += 1;
      }
      return HttpResponse.json({ updated });
    }),

    http.get('/api/alerts/:id', ({ params }) => {
      const parsed = uuidParamsSchema.safeParse(params);
      if (!parsed.success) return validationProblem(parsed.error);
      const detail = alertDetail(getDb(), parsed.data.id);
      return detail ? HttpResponse.json(detail) : problem(404, 'Not Found', 'No such alert.');
    }),

    http.patch('/api/alerts/:id', async ({ params, request }) => {
      const parsed = uuidParamsSchema.safeParse(params);
      if (!parsed.success) return validationProblem(parsed.error);
      const body = alertPatchBodySchema.safeParse(await jsonBody(request));
      if (!body.success) return validationProblem(body.error);
      const alert = getDb().alerts.find((a) => a.id === parsed.data.id);
      if (!alert) return problem(404, 'Not Found', 'No such alert.');
      alert.status = body.data.status;
      alert.resolution = body.data.resolution ?? null;
      if (body.data.note !== undefined) alert.note = body.data.note;
      alert.updatedAt = new Date().toISOString();
      return HttpResponse.json(alert);
    }),

    http.get('/api/rules', ({ request }) => {
      const query = rulesQuerySchema.safeParse(queryObject(request));
      if (!query.success) return validationProblem(query.error);
      return HttpResponse.json(listRules(getDb(), query.data));
    }),

    http.get('/api/rules/:id', ({ params }) => {
      const parsed = ruleIdParamsSchema.safeParse(params);
      if (!parsed.success) return validationProblem(parsed.error);
      const db = getDb();
      const rule = db.rules.find((r) => r.id === parsed.data.id);
      if (!rule) return problem(404, 'Not Found', 'No such rule.');
      return HttpResponse.json({ rule, source: db.ruleSources.get(rule.id) ?? '' });
    }),

    http.patch('/api/rules/:id', async ({ params, request }) => {
      const parsed = ruleIdParamsSchema.safeParse(params);
      if (!parsed.success) return validationProblem(parsed.error);
      const body = rulePatchBodySchema.safeParse(await jsonBody(request));
      if (!body.success) return validationProblem(body.error);
      const rule = getDb().rules.find((r) => r.id === parsed.data.id);
      if (!rule) return problem(404, 'Not Found', 'No such rule.');
      rule.enabled = body.data.enabled;
      return HttpResponse.json(rule);
    }),

    http.get('/api/stats/overview', ({ request }) => {
      const query = statsOverviewQuerySchema.safeParse(queryObject(request));
      if (!query.success) return validationProblem(query.error);
      return HttpResponse.json(overviewStats(getDb(), query.data));
    }),

    http.get('/api/attack', ({ request }) => {
      const query = attackQuerySchema.safeParse(queryObject(request));
      if (!query.success) return validationProblem(query.error);
      return HttpResponse.json(attackMatrix(getDb(), query.data));
    }),

    http.post('/api/ingest/upload', async ({ request }) => {
      const query = ingestQuerySchema.safeParse(queryObject(request));
      if (!query.success) return validationProblem(query.error);
      if (!(request.headers.get('content-type') ?? '').startsWith('text/plain')) {
        return problem(415, 'Unsupported Media Type', 'Send text/plain.');
      }
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_UPLOAD_BYTES) {
        return problem(413, 'Payload Too Large', 'The upload limit is 5 MB.');
      }
      return HttpResponse.json(mockIngest(query.data.source, text));
    }),
  ];
}

/** Shared mock database for the browser worker and tests; tests reset it after each case. */
let current: MockDb | undefined;

export function mockDb(): MockDb {
  current ??= createMockDb();
  return current;
}

export function resetMockDb(): void {
  current = undefined;
  resetAuthMock();
}

export const handlers = createHandlers(mockDb);
