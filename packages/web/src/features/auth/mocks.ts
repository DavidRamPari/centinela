/**
 * MSW handlers for sign-in, ingest tokens and the audit log, used in tests and with
 * VITE_USE_MOCKS=true. The mock starts signed in; signing in accepts the development
 * credentials (`admin` / `centinela-dev`). Bodies are validated with the shared schemas.
 */
import {
  CSRF_COOKIE,
  ingestTokenCreateBodySchema,
  loginBodySchema,
  type AuditEntry,
  type IngestToken,
  type SessionInfo,
} from '@centinela/shared';
import { http, HttpResponse } from 'msw';

export const MOCK_USERNAME = 'admin';
export const MOCK_PASSWORD = 'centinela-dev';
const MOCK_CSRF = 'mock-csrf-token';

interface AuthMockState {
  signedIn: boolean;
  tokens: IngestToken[];
  audit: AuditEntry[];
  nextId: number;
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

/** Deterministic UUIDv7-shaped ids, so snapshots and keys are stable. */
function mockId(n: number): string {
  return `01930f6e-8a4b-7c2d-9e1f-${hex(n, 12)}`;
}

function initialState(): AuthMockState {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    signedIn: true,
    nextId: 100,
    tokens: [
      {
        id: mockId(1),
        label: 'web-01 log shipper',
        prefix: 'cnt_Q2VudGlu',
        createdAt: at(3 * 24 * 60),
        lastUsedAt: at(2),
        revokedAt: null,
      },
      {
        id: mockId(2),
        label: 'old bastion agent',
        prefix: 'cnt_b2xkYWdl',
        createdAt: at(30 * 24 * 60),
        lastUsedAt: at(10 * 24 * 60),
        revokedAt: at(7 * 24 * 60),
      },
    ],
    audit: [
      {
        id: mockId(10),
        at: at(5),
        actor: MOCK_USERNAME,
        action: 'auth.login',
        target: null,
        ip: '192.0.2.10',
        details: {},
      },
      {
        id: mockId(11),
        at: at(60),
        actor: '<script>alert(1)</script>',
        action: 'auth.login_failed',
        target: null,
        ip: '203.0.113.66',
        details: {},
      },
    ],
  };
}

let state = initialState();

export function resetAuthMock(): void {
  state = initialState();
}

/** Tests start a case signed out with `setMockSignedIn(false)`. */
export function setMockSignedIn(signedIn: boolean): void {
  state.signedIn = signedIn;
}

function session(): SessionInfo {
  return {
    username: MOCK_USERNAME,
    expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
  };
}

function problem(
  status: number,
  title: string,
  detail: string,
  headers: Record<string, string> = {},
) {
  return HttpResponse.json(
    { type: 'about:blank', title, status, detail },
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

const unauthorized = () => problem(401, 'Unauthorized', 'Sign in to continue');

function audit(entry: Omit<AuditEntry, 'id' | 'at' | 'ip'>): void {
  state.nextId += 1;
  state.audit.unshift({
    ...entry,
    id: mockId(state.nextId),
    at: new Date().toISOString(),
    ip: '127.0.0.1',
  });
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

export function createAuthHandlers() {
  return [
    http.get('/api/auth/me', () =>
      state.signedIn ? HttpResponse.json(session()) : unauthorized(),
    ),

    http.post('/api/auth/login', async ({ request }) => {
      const body = loginBodySchema.safeParse(await jsonBody(request));
      if (!body.success) return problem(400, 'Bad Request', 'Invalid body');
      if (body.data.username !== MOCK_USERNAME || body.data.password !== MOCK_PASSWORD) {
        audit({
          actor: body.data.username,
          action: 'auth.login_failed',
          target: null,
          details: {},
        });
        return problem(401, 'Unauthorized', 'Wrong user name or password');
      }
      state.signedIn = true;
      audit({ actor: MOCK_USERNAME, action: 'auth.login', target: null, details: {} });
      // The real server sets both cookies; a mock can only set the readable one.
      document.cookie = `${CSRF_COOKIE}=${MOCK_CSRF}; Path=/; Secure; SameSite=Strict`;
      return HttpResponse.json(session());
    }),

    http.post('/api/auth/logout', () => {
      if (!state.signedIn) return unauthorized();
      state.signedIn = false;
      audit({ actor: MOCK_USERNAME, action: 'auth.logout', target: null, details: {} });
      return new HttpResponse(null, { status: 204 });
    }),

    http.get('/api/tokens', () =>
      state.signedIn ? HttpResponse.json({ items: state.tokens }) : unauthorized(),
    ),

    http.post('/api/tokens', async ({ request }) => {
      if (!state.signedIn) return unauthorized();
      const body = ingestTokenCreateBodySchema.safeParse(await jsonBody(request));
      if (!body.success) return problem(400, 'Bad Request', 'Invalid body');
      state.nextId += 1;
      const secret = `cnt_mock${hex(state.nextId, 39)}`;
      const token: IngestToken = {
        id: mockId(state.nextId),
        label: body.data.label,
        prefix: secret.slice(0, 12),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      state.tokens.unshift(token);
      audit({
        actor: MOCK_USERNAME,
        action: 'token.create',
        target: token.id,
        details: { label: token.label },
      });
      return HttpResponse.json({ token, secret }, { status: 201 });
    }),

    http.post('/api/tokens/:id/revoke', ({ params }) => {
      if (!state.signedIn) return unauthorized();
      const token = state.tokens.find((t) => t.id === params.id);
      if (!token) return problem(404, 'Not Found', 'Token not found');
      if (!token.revokedAt) {
        token.revokedAt = new Date().toISOString();
        audit({
          actor: MOCK_USERNAME,
          action: 'token.revoke',
          target: token.id,
          details: { label: token.label },
        });
      }
      return HttpResponse.json(token);
    }),

    http.get('/api/audit', ({ request }) => {
      if (!state.signedIn) return unauthorized();
      const action = new URL(request.url).searchParams.get('action');
      const actions = action ? action.split(',') : undefined;
      const items = state.audit.filter((entry) => !actions || actions.includes(entry.action));
      return HttpResponse.json({ items, nextCursor: null });
    }),
  ];
}
