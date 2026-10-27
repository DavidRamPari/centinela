import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { RateLimitOptions } from '../config.js';
import { problem, sendProblem } from '../http/problem.js';

/**
 * Per-client-IP rate limit (in memory) that answers `429` problem+json with the draft-8
 * `RateLimit` headers. Behind a reverse proxy, set `TRUST_PROXY` so the client IP is used.
 */
export function createRateLimiter(
  { windowMs, limit }: RateLimitOptions,
  detail: string,
): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      sendProblem(res, problem(429, detail));
    },
  });
}
