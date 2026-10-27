import { CSRF_COOKIE, CSRF_HEADER, LOCAL_CSRF_COOKIE } from '@centinela/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiRequest, onUnauthorized } from '../src/api/client';
import { actionKey, formatDetails } from '../src/features/auth/audit-format';
import { MOCK_PASSWORD, MOCK_USERNAME } from '../src/features/auth/mocks';
import { loginPath, safeNextPath } from '../src/features/auth/next-path';
import { currentSearch, renderApp } from './render';
import { server } from './setup';

function setCsrfCookie(value: string) {
  document.cookie = `${CSRF_COOKIE}=${value}; Path=/; Secure; SameSite=Strict`;
}

afterEach(() => {
  document.cookie = `${CSRF_COOKIE}=; Path=/; Secure; Max-Age=0`;
  document.cookie = `${LOCAL_CSRF_COOKIE}=; Path=/; Max-Age=0`;
});

async function signInWith(user: ReturnType<typeof userEvent.setup>, password: string) {
  await user.type(await screen.findByLabelText('User name'), MOCK_USERNAME);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('API client and the session', () => {
  it('repeats the CSRF cookie in a header on state-changing requests only', async () => {
    setCsrfCookie('token-123');
    const seen: Array<{ method: string; csrf: string | null }> = [];
    server.use(
      http.all('/api/echo', ({ request }) => {
        seen.push({ method: request.method, csrf: request.headers.get(CSRF_HEADER) });
        return HttpResponse.json({ ok: true });
      }),
    );
    const schema = z.object({ ok: z.boolean() });
    await apiRequest('/echo', schema);
    await apiRequest('/echo', schema, { method: 'POST', json: {} });
    await apiRequest('/echo', schema, { method: 'PATCH', json: {} });
    expect(seen).toEqual([
      { method: 'GET', csrf: null },
      { method: 'POST', csrf: 'token-123' },
      { method: 'PATCH', csrf: 'token-123' },
    ]);
  });

  it('repeats the unprefixed CSRF cookie of a plain-HTTP localhost server', async () => {
    // A development server on http://localhost sets `centinela-local-csrf` (no `Secure`,
    // which Safari would refuse there) instead of the `__Host-` cookie.
    document.cookie = `${LOCAL_CSRF_COOKIE}=local-456; Path=/; SameSite=Strict`;
    const seen: Array<string | null> = [];
    server.use(
      http.post('/api/echo', ({ request }) => {
        seen.push(request.headers.get(CSRF_HEADER));
        return HttpResponse.json({ ok: true });
      }),
    );
    const schema = z.object({ ok: z.boolean() });
    await apiRequest('/echo', schema, { method: 'POST', json: {} });
    setCsrfCookie('host-789');
    await apiRequest('/echo', schema, { method: 'POST', json: {} });
    expect(seen).toEqual(['local-456', 'host-789']);
  });

  it('tells listeners about a 401 unless the call opts out, and reads Retry-After', async () => {
    server.use(
      http.get('/api/gone', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Unauthorized', status: 401 },
          {
            status: 401,
            headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '90' },
          },
        ),
      ),
    );
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    const error = await apiRequest('/gone', z.unknown()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryAfterSeconds).toBe(90);
    await apiRequest('/gone', z.unknown(), { notifyUnauthorized: false }).catch(() => undefined);
    unsubscribe();
    await apiRequest('/gone', z.unknown()).catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/alerts?status=new', '/alerts?status=new'],
    ['//evil.example/x', '/'],
    ['https://evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/alerts\nSet-Cookie', '/'],
    ['/login?next=/x', '/'],
    [null, '/'],
  ])('keeps sign-in redirects inside the dashboard: %s → %s', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it('builds sign-in links', () => {
    expect(loginPath('/')).toBe('/login');
    expect(loginPath('/rules?q=ssh')).toBe('/login?next=%2Frules%3Fq%3Dssh');
  });
});

describe('sign-in flow', () => {
  it('sends a signed-out analyst to the sign-in page and back where they were', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({
      path: '/alerts?status=new',
      language: 'en',
      auth: 'signed-out',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(currentSearch(router).get('next')).toBe('/alerts?status=new');
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();

    await signInWith(user, MOCK_PASSWORD);
    expect(await screen.findByRole('heading', { level: 1, name: 'Alerts' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/alerts');
    expect(currentSearch(router).get('status')).toBe('new');
    expect(screen.getByText(MOCK_USERNAME)).toBeInTheDocument();
  });

  it('checks the session before showing the dashboard', async () => {
    renderApp({ path: '/rules', language: 'en', auth: 'fetch' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(await screen.findByRole('heading', { level: 1, name: 'Rules' })).toBeInTheDocument();
  });

  it('shows a wrong password without leaving the page', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/login', language: 'en', auth: 'signed-out' });
    await signInWith(user, 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong user name or password.');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('explains a lockout with the waiting time, in Spanish too', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Too Many Requests', status: 429 },
          {
            status: 429,
            headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '900' },
          },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp({ path: '/login', language: 'es', auth: 'signed-out' });
    await user.type(await screen.findByLabelText('Usuario'), MOCK_USERNAME);
    await user.type(screen.getByLabelText('Contraseña'), MOCK_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Demasiados intentos fallidos. Vuelve a intentarlo en 15 min.',
    );
  });

  it('ignores a ?next= that leaves the dashboard', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({
      path: '/login?next=%2F%2Fevil.example',
      language: 'en',
      auth: 'signed-out',
    });
    await signInWith(user, MOCK_PASSWORD);
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('redirects to the sign-in page when the session ends mid-use', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/', language: 'en' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    server.use(
      http.get('/api/rules', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Unauthorized', status: 401 },
          { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    await user.click(within(nav).getByRole('link', { name: 'Rules' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(currentSearch(router).get('next')).toBe('/rules');
  });

  it('signs out with the CSRF header and returns to the sign-in page', async () => {
    setCsrfCookie('csrf-for-logout');
    let csrf: string | null = null;
    server.use(
      http.post('/api/auth/logout', ({ request }) => {
        csrf = request.headers.get(CSRF_HEADER);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get('/api/auth/me', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Unauthorized', status: 401 },
          { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const user = userEvent.setup();
    const { router, queryClient } = renderApp({ path: '/alerts', language: 'en' });
    await screen.findByRole('heading', { level: 1, name: 'Alerts' });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(csrf).toBe('csrf-for-logout');
    expect(router.state.location.pathname).toBe('/login');
    expect(queryClient.getQueryCache().findAll({ queryKey: ['alerts'] })).toHaveLength(0);
  });
});

describe('security page', () => {
  it('creates a token, shows its secret once, and revokes tokens in two steps', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/security', language: 'en' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Security' })).toBeInTheDocument();
    const tokensTable = await screen.findByRole('table', { name: 'Ingest tokens' });
    expect(within(tokensTable).getByText('web-01 log shipper')).toBeInTheDocument();
    expect(within(tokensTable).getByText(/^Revoked /)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Label'), 'db-01 shipper');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const created = await screen.findByText('Token "db-01 shipper" created');
    const box = created.closest('[role="status"]') as HTMLElement;
    const secret = within(box).getByLabelText('New ingest token').textContent ?? '';
    expect(secret).toMatch(/^cnt_/);
    expect(within(box).getByText(/cannot be shown again/)).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'I copied it' }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();

    const row = (await screen.findByText('db-01 shipper')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    await user.click(within(row).getByRole('button', { name: 'Confirm revoking "db-01 shipper"' }));
    await waitFor(() => expect(within(row).getByText(/^Revoked /)).toBeInTheDocument());
    expect(within(row).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('refuses an empty label before sending it', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/security', language: 'en' });
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a label of 1 to 100');
  });

  it('lists the audit log as text, with hostile values left inert', async () => {
    const user = userEvent.setup();
    const { container } = renderApp({ path: '/security', language: 'en' });
    const table = await screen.findByRole('table', { name: 'Audit log' });
    expect(within(table).getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(within(table).getByText('Failed sign-in')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Action'), 'auth.login');
    await waitFor(() =>
      expect(within(table).queryByText('Failed sign-in')).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('table', { name: 'Audit log' })).getByText('Signed in'),
    ).toBeInTheDocument();
  });

  it('formats details and action keys', () => {
    expect(formatDetails({ status: 'closed', updated: ['a', 'b'], note: null })).toBe(
      'status=closed updated=["a","b"] note=null',
    );
    expect(actionKey('auth.login_failed')).toBe('auth_login_failed');
  });

  it('is reachable from the sidebar in Spanish', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/', language: 'es' });
    const nav = await screen.findByRole('navigation', { name: 'Navegación principal' });
    await user.click(within(nav).getByRole('link', { name: 'Seguridad' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Seguridad' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Tokens de ingesta' })).toBeInTheDocument();
  });
});
