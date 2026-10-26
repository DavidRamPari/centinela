/**
 * Router registry: every `/api` route is mounted here, in this order:
 * health → ingest (own body parsers and limits) → JSON body parser → resource routers.
 */
import express, { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { createIngestRouter } from '../ingest/router.js';
import { createHealthRouter } from './health.js';
import { createNotImplementedRouter } from './not-implemented.js';

/** Largest JSON body the API accepts (triage notes, bulk id lists). */
export const JSON_BODY_LIMIT = '100kb';

export function createApiRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(createHealthRouter(deps));
  router.use(createIngestRouter(deps));
  router.use(express.json({ limit: JSON_BODY_LIMIT }));
  router.use(createNotImplementedRouter());
  return router;
}
