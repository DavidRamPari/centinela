/**
 * Ingest endpoints (ARCHITECTURE §9): `POST /api/ingest` (bearer token) and
 * `POST /api/ingest/upload` (dashboard). Session S1 implements them, including their
 * text/NDJSON body parsers, the 5 MB limit and rate limiting; until then both answer `501`.
 */
import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { notImplemented } from '../routes/not-implemented.js';

export function createIngestRouter(_deps: AppDeps): Router {
  const router = Router();
  router.post('/ingest', notImplemented('POST /api/ingest', 'S1'));
  router.post('/ingest/upload', notImplemented('POST /api/ingest/upload', 'S1'));
  return router;
}
