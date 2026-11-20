import type { RequestHandler } from 'express';
import type { IngestCredential } from '../auth/ingest-tokens.js';
import { HttpError } from '../http/problem.js';
import { clientIp } from '../security/client-ip.js';
import { sendRateLimited, type WindowCounter } from '../security/rate-limit.js';

export { safeEqual as tokensEqual } from '../security/compare.js';

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;

export const TOO_MANY_FAILURES = 'Too many requests without a valid token; retry later';

/** The credential `requireBearerToken` found, for the handlers after it. */
export function credentialOf(locals: Record<string, unknown>): IngestCredential | undefined {
  return locals.ingestCredential as IngestCredential | undefined;
}

/**
 * `Authorization: Bearer <token>`; a missing or rejected token is a `401` problem. `verify`
 * decides (S6: the `INGEST_TOKEN` variable or an active token from the dashboard) and
 * answers the credential, which later handlers read with `credentialOf`.
 *
 * Requests without a valid token are counted per client address (S11). An address that
 * reached its limit is answered `429` with `Retry-After` until its window ends, without
 * looking at the token it sends: otherwise a guesser past the limit could still find one.
 */
export function requireBearerToken(
  verify: (token: string) => Promise<IngestCredential | null>,
  failures: WindowCounter,
): RequestHandler {
  return async (req, res, next) => {
    const address = clientIp(req) ?? 'unknown';
    const wait = failures.wait(address);
    if (wait > 0) {
      sendRateLimited(res, wait, TOO_MANY_FAILURES);
      return;
    }
    const match = BEARER.exec(req.get('authorization') ?? '');
    const credential = match ? await verify(match[1] ?? '') : null;
    if (credential === null) {
      failures.add(address);
      res.set('WWW-Authenticate', 'Bearer realm="centinela-ingest"');
      next(new HttpError(401, 'A valid bearer token is required'));
      return;
    }
    res.locals.ingestCredential = credential;
    next();
  };
}
