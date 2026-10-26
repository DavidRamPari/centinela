import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError, api, toSearchParams } from '../src/api/client';
import { server } from './setup';

describe('API client', () => {
  it('builds query strings, dropping empty values and joining arrays', () => {
    expect(
      toSearchParams({
        level: ['high', 'critical'],
        q: '',
        host: undefined,
        limit: 50,
        enabled: false,
      }).toString(),
    ).toBe('level=high%2Ccritical&limit=50&enabled=false');
  });

  it('parses responses with the shared schemas', async () => {
    let seenUrl = '';
    server.use(
      http.get('/api/alerts', ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    await expect(api.listAlerts({ status: ['new'], limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(new URL(seenUrl).search).toBe('?status=new&limit=10');
  });

  it('rejects responses that do not match the contract', async () => {
    server.use(
      http.get('/api/alerts', () => HttpResponse.json({ items: [{ id: 1 }], nextCursor: null })),
    );
    await expect(api.listAlerts()).rejects.toThrow();
  });

  it('turns problem+json errors into ApiError', async () => {
    server.use(
      http.get('/api/events', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Not Implemented',
            status: 501,
            detail: 'GET /api/events is implemented in session S4',
          },
          { status: 501, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const error: unknown = await api.listEvents().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(501);
    expect((error as ApiError).message).toContain('session S4');
  });

  it('sends JSON bodies for mutations', async () => {
    let body: unknown;
    server.use(
      http.post('/api/alerts/bulk', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ updated: 1 });
      }),
    );
    const ids = ['01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f'];
    await expect(api.bulkUpdateAlerts({ ids, status: 'acknowledged' })).resolves.toEqual({
      updated: 1,
    });
    expect(body).toEqual({ ids, status: 'acknowledged' });
  });
});
