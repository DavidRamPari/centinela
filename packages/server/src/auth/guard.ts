/**
 * Session guard for the dashboard API: `requireSession` answers `401` unless the request
 * carries the cookie of a live session for the configured admin; `requireCsrf` then
 * answers `403` for state-changing requests without the session's CSRF token.
 */
import type { RequestHandler, Response } from 'express';
import { HttpError } from '../http/problem.js';
import { cookieMode, readCookie } from '../security/cookies.js';
import { csrfTokenFor, requireCsrfToken } from '../security/csrf.js';
import type { Session, SessionStore } from './sessions.js';

export interface AuthLocals {
  session: Session;
  /** The cookie token (needed to derive the CSRF token and to sign out). */
  token: string;
  csrfToken: string;
}

const LOCALS_KEY = 'auth';

/** The signed-in session of a request that passed `requireSession`. */
export function authOf(res: Response): AuthLocals {
  const locals = (res.locals as Record<string, unknown>)[LOCALS_KEY] as AuthLocals | undefined;
  if (!locals) throw new Error('authOf() used on a route without requireSession');
  return locals;
}

export interface SessionGuardOptions {
  sessions: SessionStore;
  secret: string;
  /** Sessions of any other user name (the admin was renamed) are refused. */
  username: string;
  /** Production always reads the `__Host-` cookies (`cookieMode`). */
  isProduction: boolean;
}

export interface SessionGuard {
  /** `touch: false` checks the session without counting the request as activity. */
  requireSession(options?: { touch?: boolean }): RequestHandler;
  requireCsrf: RequestHandler;
}

export function createSessionGuard({
  sessions,
  secret,
  username,
  isProduction,
}: SessionGuardOptions): SessionGuard {
  return {
    requireSession({ touch = true } = {}) {
      return async (req, res, next) => {
        const token = readCookie(req.headers.cookie, cookieMode(req, isProduction).session);
        const session = token === undefined ? undefined : await sessions.find(token, { touch });
        if (!token || !session || session.username !== username) {
          throw new HttpError(401, 'Sign in to continue');
        }
        const locals: AuthLocals = { session, token, csrfToken: csrfTokenFor(secret, token) };
        (res.locals as Record<string, unknown>)[LOCALS_KEY] = locals;
        next();
      };
    },
    requireCsrf: requireCsrfToken(
      (res) => authOf(res).csrfToken,
      (req) => cookieMode(req, isProduction).csrf,
    ),
  };
}
