import { Router } from 'express';
import type { HealthResponse } from '@centinela/shared';
import { checkDatabase } from '../db/pool.js';
import type { AppDeps } from '../deps.js';
import { version } from '../version.js';

/** `GET /api/health`: `200` when the database answers, `503` otherwise. */
export function createHealthRouter({ pool }: Pick<AppDeps, 'pool'>): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const dbOk = await checkDatabase(pool);
    const body: HealthResponse = dbOk
      ? { status: 'ok', db: 'ok', version }
      : { status: 'degraded', db: 'down', version };
    res
      .status(dbOk ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(body);
  });
  return router;
}
