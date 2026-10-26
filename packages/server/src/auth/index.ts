/**
 * Authentication for the HTTP layer (session S6), built once per app by `createApp`:
 * session store and guard, CSRF check, login lockout, session-bound live streams, the
 * ingest token verifier, and the `/auth`, `/tokens` and `/audit` routers.
 */
import type { RequestHandler, Router } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { createAdminRouter } from './admin-router.js';
import { authOf, createSessionGuard, type SessionGuard } from './guard.js';
import { createIngestTokenVerifier } from './ingest-tokens.js';
import { createLoginLockout } from './lockout.js';
import { createAuthRouter } from './router.js';
import { createSessionStore, type SessionStore } from './sessions.js';
import { createSessionStreams, type SessionStreams } from './streams.js';

export interface Auth extends SessionGuard {
  sessions: SessionStore;
  streams: SessionStreams;
  /** Bearer token check for `POST /api/ingest` (environment token or an active stored token). */
  verifyIngestToken: (token: string) => Promise<boolean>;
  /** `/auth/login` (public), `/auth/me`, `/auth/logout`. */
  authRouter: Router;
  /** `/tokens` and `/audit`; mount behind `requireSession` and `requireCsrf`. */
  adminRouter: Router;
  /** Ties `GET /stream` responses to their session; mount behind `requireSession`. */
  trackStreams: RequestHandler;
}

export function sessionStoreFor(config: Config, pool: Pool): SessionStore {
  return createSessionStore({
    pool,
    secret: config.sessionSecret,
    idleMs: config.session.idleMs,
    maxAgeMs: config.session.maxAgeMs,
  });
}

export function createAuth({ config, pool }: { config: Config; pool: Pool }): Auth {
  const sessions = sessionStoreFor(config, pool);
  const guard = createSessionGuard({
    sessions,
    secret: config.sessionSecret,
    username: config.admin.username,
  });
  const lockout = createLoginLockout(config.login);
  const streams = createSessionStreams((res) => authOf(res).session);
  return {
    ...guard,
    sessions,
    streams,
    verifyIngestToken: createIngestTokenVerifier(pool, config.ingestToken),
    authRouter: createAuthRouter({ config, pool, sessions, guard, lockout, streams }),
    adminRouter: createAdminRouter({ pool }),
    trackStreams: streams.track,
  };
}
