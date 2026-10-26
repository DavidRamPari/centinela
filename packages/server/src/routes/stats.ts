import { statsOverviewQuerySchema } from '@centinela/shared';
import { Router } from 'express';
import { overviewStats } from '../db/stats.js';
import type { AppDeps } from '../deps.js';
import { validate } from '../http/validate.js';
import { resolveTimeRange } from './query.js';

/** `GET /api/stats/overview`: KPI numbers, time series and top lists for the dashboard. */
export function createStatsRouter({ pool }: Pick<AppDeps, 'pool'>): Router {
  const router = Router();
  router.get('/stats/overview', async (req, res) => {
    const query = validate(statsOverviewQuerySchema, req.query, 'query');
    res.json(await overviewStats(pool, resolveTimeRange(query), query.bucket));
  });
  return router;
}
