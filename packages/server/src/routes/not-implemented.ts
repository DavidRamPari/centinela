import { Router, type RequestHandler } from 'express';
import { problem, sendProblem } from '../http/problem.js';

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface PendingEndpoint {
  method: HttpMethod;
  /** Path below `/api`. */
  path: string;
  /** Session that implements it (docs/PLAN.md). */
  session: string;
}

/**
 * Endpoints from ARCHITECTURE §9 that still answer `501`. A session that implements an
 * endpoint removes its row here and in `test/routes/not-implemented.test.ts`.
 */
export const pendingEndpoints: readonly PendingEndpoint[] = [
  { method: 'get', path: '/events', session: 'S4' },
  { method: 'get', path: '/events/:id', session: 'S4' },
  { method: 'get', path: '/alerts', session: 'S4' },
  { method: 'post', path: '/alerts/bulk', session: 'S4' },
  { method: 'get', path: '/alerts/:id', session: 'S4' },
  { method: 'patch', path: '/alerts/:id', session: 'S4' },
  { method: 'get', path: '/rules', session: 'S4' },
  { method: 'get', path: '/rules/:id/playbook', session: 'S7' },
  { method: 'get', path: '/rules/:id', session: 'S4' },
  { method: 'patch', path: '/rules/:id', session: 'S4' },
  { method: 'get', path: '/stats/overview', session: 'S4' },
  { method: 'get', path: '/attack', session: 'S4' },
  { method: 'get', path: '/stream', session: 'S4' },
  { method: 'post', path: '/auth/login', session: 'S6' },
  { method: 'post', path: '/auth/logout', session: 'S6' },
  { method: 'get', path: '/auth/me', session: 'S6' },
];

/** `501` problem naming the endpoint (e.g. `GET /api/events`) and the session that implements it. */
export function notImplemented(endpoint: string, session: string): RequestHandler {
  return (_req, res) => {
    sendProblem(res, problem(501, `${endpoint} is implemented in session ${session}`));
  };
}

export function createNotImplementedRouter(
  endpoints: readonly PendingEndpoint[] = pendingEndpoints,
): Router {
  const router = Router();
  for (const endpoint of endpoints) {
    const label = `${endpoint.method.toUpperCase()} /api${endpoint.path}`;
    router[endpoint.method](endpoint.path, notImplemented(label, endpoint.session));
  }
  return router;
}
