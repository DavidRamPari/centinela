import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from '../http/problem.js';

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;

/**
 * Compare two secrets in constant time. Hashing first gives equal-length inputs to
 * `timingSafeEqual`, so neither the content nor the length of the token leaks.
 */
export function tokensEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>`; a missing or wrong token is a `401` problem. */
export function requireBearerToken(expected: string): RequestHandler {
  return (req, res, next) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match || !tokensEqual(match[1] ?? '', expected)) {
      res.set('WWW-Authenticate', 'Bearer realm="centinela-ingest"');
      next(new HttpError(401, 'A valid bearer token is required'));
      return;
    }
    next();
  };
}
