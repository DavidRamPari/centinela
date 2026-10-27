/**
 * CSRF protection: double-submit cookie bound to the session (OWASP "signed double-submit").
 *
 * At sign-in the server sets `__Host-centinela-csrf` (`centinela-local-csrf` over plain HTTP on
 * localhost in development, see `cookies.ts`) to HMAC-SHA256(SESSION_SECRET, session token). On every state-changing request the dashboard repeats that value in `X-CSRF-Token`.
 * The request passes only when the header equals the cookie *and* the value the server
 * derives from the session cookie. A cross-site page can make the browser send cookies
 * (SameSite=Strict already prevents that in current browsers) but it cannot read them, so it
 * cannot produce the header; a token from another session does not match this session.
 */
import { createHmac } from 'node:crypto';
import { CSRF_HEADER } from '@centinela/shared';
import type { Request, RequestHandler } from 'express';
import { HttpError } from '../http/problem.js';
import { readCookie } from './cookies.js';
import { safeEqual } from './compare.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfTokenFor(secret: string, sessionToken: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionToken}`, 'utf8').digest('base64url');
}

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Middleware for routes behind the session: `expected` returns the CSRF token of the
 * request's session (set by the session guard) and `cookieName` the name of the request's
 * CSRF cookie. Safe methods pass; others need the header.
 */
export function requireCsrfToken(
  expected: (res: Parameters<RequestHandler>[1]) => string,
  cookieName: (req: Request) => string,
): RequestHandler {
  return (req, res, next) => {
    if (!isStateChanging(req.method)) {
      next();
      return;
    }
    const header = req.get(CSRF_HEADER) ?? '';
    const cookie = readCookie(req.headers.cookie, cookieName(req)) ?? '';
    const token = expected(res);
    // Evaluate every comparison (no short circuit), so timing does not tell which one failed.
    const headerOk = safeEqual(header, token);
    const cookieOk = safeEqual(cookie, token);
    if (header === '' || !headerOk || !cookieOk) {
      next(new HttpError(403, 'A valid CSRF token is required'));
      return;
    }
    next();
  };
}
