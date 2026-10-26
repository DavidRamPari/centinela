/**
 * MSW handlers used in tests and when VITE_USE_MOCKS=true. Session S3 adds fixtures
 * built from the shared schemas; for now lists are empty.
 */
import type { HealthResponse, Page } from '@centinela/shared';
import { http, HttpResponse } from 'msw';

const emptyPage: Page<never> = { items: [], nextCursor: null };

export const handlers = [
  http.get('/api/health', () =>
    HttpResponse.json<HealthResponse>({ status: 'ok', db: 'ok', version: '0.1.0-mock' }),
  ),
  http.get('/api/events', () => HttpResponse.json(emptyPage)),
  http.get('/api/alerts', () => HttpResponse.json(emptyPage)),
  http.get('/api/rules', () => HttpResponse.json(emptyPage)),
];
