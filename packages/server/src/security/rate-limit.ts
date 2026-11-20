import type { RequestHandler, Response } from 'express';
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

/**
 * A fixed-window count per key, for limits keyed by something other than the client
 * address (S11: one budget per ingest token, and one per address for requests without a
 * valid token). Each key's window starts at its first count. In memory and bounded: past
 * `maxKeys`, expired windows are dropped first, then the oldest.
 */
export interface WindowCounter {
  /** Seconds until `key` may be counted again; 0 while it is under its limit. */
  wait(key: string): number;
  /** Count one for `key`. */
  add(key: string): void;
}

export interface WindowCounterOptions {
  now?: () => number;
  maxKeys?: number;
}

export const DEFAULT_MAX_COUNTER_KEYS = 100_000;

export function createWindowCounter(
  { windowMs, limit }: RateLimitOptions,
  options: WindowCounterOptions = {},
): WindowCounter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_COUNTER_KEYS;
  const windows = new Map<string, { count: number; resetAt: number }>();

  function makeRoom(at: number): void {
    for (const [key, entry] of windows) {
      if (entry.resetAt <= at) windows.delete(key);
    }
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }

  return {
    wait(key) {
      const entry = windows.get(key);
      const at = now();
      if (entry === undefined || entry.resetAt <= at || entry.count < limit) return 0;
      return Math.max(1, Math.ceil((entry.resetAt - at) / 1000));
    },
    add(key) {
      const at = now();
      const entry = windows.get(key);
      if (entry !== undefined && entry.resetAt > at) {
        entry.count += 1;
        return;
      }
      windows.delete(key);
      if (windows.size >= maxKeys) makeRoom(at);
      windows.set(key, { count: 1, resetAt: at + windowMs });
    },
  };
}

/** `429` problem+json with `Retry-After`. */
export function sendRateLimited(res: Response, retryAfterSeconds: number, detail: string): void {
  res.set('Retry-After', String(retryAfterSeconds));
  sendProblem(res, problem(429, detail));
}
