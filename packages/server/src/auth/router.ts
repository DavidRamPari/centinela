/**
 * `POST /api/auth/login`, `GET /api/auth/me` and `POST /api/auth/logout` (ARCHITECTURE §9).
 *
 * Every `/api/auth/*` request counts against a per-IP rate limit. Sign-in checks, in order:
 * lockout (refused before any password work) → body → password (argon2id, at most
 * `MAX_CONCURRENT_PASSWORD_CHECKS` at once) and user name (constant time). The password is
 * always checked, so a wrong user name takes as long as a wrong password.
 */
import { CSRF_COOKIE, SESSION_COOKIE, loginBodySchema, type SessionInfo } from '@centinela/shared';
import express, { Router, type Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { withTransaction } from '../db/sql.js';
import { HttpError, problem, sendProblem } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { clientIp } from '../security/client-ip.js';
import { safeEqual } from '../security/compare.js';
import {
  clearCookieOptions,
  csrfCookieOptions,
  readCookie,
  sessionCookieOptions,
} from '../security/cookies.js';
import { csrfTokenFor } from '../security/csrf.js';
import { createRateLimiter } from '../security/rate-limit.js';
import { recordAudit } from './audit.js';
import { authOf, type SessionGuard } from './guard.js';
import type { LoginLockout } from './lockout.js';
import { verifyPassword } from './password.js';
import type { Session, SessionStore } from './sessions.js';
import type { SessionStreams } from './streams.js';

/** Each argon2id check holds 64 MiB for about 150 ms; more parallel checks wait for a retry. */
export const MAX_CONCURRENT_PASSWORD_CHECKS = 4;
const LOGIN_BODY_LIMIT = '4kb';

export interface AuthRouterOptions {
  config: Config;
  pool: Pool;
  sessions: SessionStore;
  guard: SessionGuard;
  lockout: LoginLockout;
  streams: SessionStreams;
}

function sessionInfo(session: Session): SessionInfo {
  return { username: session.username, expiresAt: session.expiresAt.toISOString() };
}

function remainingMs(session: Session): number {
  return Math.max(0, session.expiresAt.getTime() - Date.now());
}

function sendLocked(res: Response, retryAfterMs: number): void {
  res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  sendProblem(res, problem(429, 'Too many failed sign-in attempts; try again later'));
}

export function createAuthRouter({
  config,
  pool,
  sessions,
  guard,
  lockout,
  streams,
}: AuthRouterOptions): Router {
  const router = Router();
  let checking = 0;

  router.use(
    '/auth',
    createRateLimiter(
      config.rateLimits.auth,
      'Too many sign-in requests; slow down and retry later',
    ),
  );

  router.post('/auth/login', express.json({ limit: LOGIN_BODY_LIMIT }), async (req, res) => {
    const ip = clientIp(req);
    const key = ip ?? 'unknown';
    const state = lockout.check(key);
    if (state.locked) {
      sendLocked(res, state.retryAfterMs);
      return;
    }
    const body = validate(loginBodySchema, req.body, 'body');
    if (checking >= MAX_CONCURRENT_PASSWORD_CHECKS) {
      res.set('Retry-After', '1');
      throw new HttpError(503, 'Sign-in is busy; retry in a moment');
    }
    checking += 1;
    let passwordOk: boolean;
    try {
      passwordOk = await verifyPassword(config.admin.passwordHash, body.password);
    } finally {
      checking -= 1;
    }
    const usernameOk = safeEqual(body.username, config.admin.username);

    if (!passwordOk || !usernameOk) {
      const after = lockout.recordFailure(key);
      // One transaction, failure first: the lockout row never exists without the failed
      // sign-in that caused it, and `seq` orders them as written.
      await withTransaction(pool, async (client) => {
        await recordAudit(client, { actor: body.username, action: 'auth.login_failed', ip });
        if (after.locked) {
          await recordAudit(client, {
            actor: body.username,
            action: 'auth.lockout',
            ip,
            details: { seconds: Math.ceil(after.retryAfterMs / 1000) },
          });
        }
      });
      if (after.locked) {
        sendLocked(res, after.retryAfterMs);
        return;
      }
      throw new HttpError(401, 'Wrong user name or password');
    }

    lockout.recordSuccess(key);
    // A new token on every sign-in (no session fixation); the browser's old session goes.
    const previous = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (previous !== undefined) {
      streams.endSession(sessions.idHash(previous));
      await sessions.delete(previous);
    }
    const { token, session } = await sessions.create({
      username: config.admin.username,
      ip,
      userAgent: req.get('user-agent') ?? null,
    });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(config.session.maxAgeMs));
    res.cookie(
      CSRF_COOKIE,
      csrfTokenFor(config.sessionSecret, token),
      csrfCookieOptions(config.session.maxAgeMs),
    );
    await recordAudit(pool, { actor: session.username, action: 'auth.login', ip });
    res.json(sessionInfo(session));
  });

  // Checking the session is not activity: the dashboard polls this to notice expiry.
  router.get('/auth/me', guard.requireSession({ touch: false }), (_req, res) => {
    const { session, csrfToken } = authOf(res);
    // Re-issue the CSRF cookie in case the browser lost it.
    res.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(remainingMs(session)));
    res.json(sessionInfo(session));
  });

  router.post('/auth/logout', guard.requireSession(), guard.requireCsrf, async (req, res) => {
    const { session, token } = authOf(res);
    await sessions.delete(token);
    streams.endSession(session.idHash);
    res.clearCookie(SESSION_COOKIE, clearCookieOptions(true));
    res.clearCookie(CSRF_COOKIE, clearCookieOptions(false));
    await recordAudit(pool, { actor: session.username, action: 'auth.logout', ip: clientIp(req) });
    res.status(204).end();
  });

  return router;
}
