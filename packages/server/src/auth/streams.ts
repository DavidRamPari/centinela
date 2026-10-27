/**
 * Live streams (`GET /api/stream`) belong to the session that opened them: signing out
 * ends that session's streams, and every stream ends when its session reaches its absolute
 * expiry. Without this, an SSE connection opened with a stolen or expired cookie would keep
 * receiving alerts after the session is gone.
 */
import type { RequestHandler, Response } from 'express';

export interface SessionStreams {
  /** Middleware placed before the stream route (after the session guard). */
  readonly track: RequestHandler;
  /** End every stream of a session (sign-out). */
  endSession(idHash: Buffer): void;
  /** Open streams being tracked (for tests). */
  readonly size: number;
}

export function createSessionStreams(
  sessionOf: (res: Response) => { idHash: Buffer; expiresAt: Date },
  now: () => number = Date.now,
): SessionStreams {
  const bySession = new Map<string, Set<Response>>();
  let size = 0;

  function end(res: Response): void {
    if (!res.writableEnded) res.end();
  }

  const track: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/stream') {
      next();
      return;
    }
    const { idHash, expiresAt } = sessionOf(res);
    const key = idHash.toString('hex');
    let streams = bySession.get(key);
    if (!streams) {
      streams = new Set();
      bySession.set(key, streams);
    }
    const set = streams;
    set.add(res);
    size += 1;
    const timer = setTimeout(() => end(res), Math.max(0, expiresAt.getTime() - now()));
    timer.unref();
    res.once('close', () => {
      clearTimeout(timer);
      if (set.delete(res)) size -= 1;
      if (set.size === 0 && bySession.get(key) === set) bySession.delete(key);
    });
    next();
  };

  return {
    track,
    endSession(idHash) {
      for (const res of bySession.get(idHash.toString('hex')) ?? []) end(res);
    },
    get size() {
      return size;
    },
  };
}
