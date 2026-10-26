import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { HttpError } from '../http/problem.js';

/** `GET /api/stream`: live alert changes as Server-Sent Events (ARCHITECTURE §10). */
export function createStreamRouter({ hub }: Pick<AppDeps, 'hub'>): Router {
  const router = Router();
  router.get('/stream', (_req, res) => {
    if (!hub.attach(res)) {
      throw new HttpError(503, 'Too many live connections; try again later');
    }
  });
  return router;
}
