import type { RequestHandler } from 'express';
import { HttpError } from '../http/problem.js';

export { safeEqual as tokensEqual } from '../security/compare.js';

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;

/**
 * `Authorization: Bearer <token>`; a missing or rejected token is a `401` problem. `verify`
 * decides (S6: the `INGEST_TOKEN` variable or an active token from the dashboard).
 */
export function requireBearerToken(
  verify: (token: string) => boolean | Promise<boolean>,
): RequestHandler {
  return async (req, res, next) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match || !(await verify(match[1] ?? ''))) {
      res.set('WWW-Authenticate', 'Bearer realm="centinela-ingest"');
      next(new HttpError(401, 'A valid bearer token is required'));
      return;
    }
    next();
  };
}
