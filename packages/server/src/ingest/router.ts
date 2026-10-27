/**
 * Ingest endpoints (ARCHITECTURE §9):
 *
 * - `POST /api/ingest`: for agents and scripts. Bearer token (`INGEST_TOKEN`, compared in
 *   constant time, or an active token created in the dashboard), body `text/plain` lines or
 *   `application/x-ndjson`, at most 5 MB.
 * - `POST /api/ingest/upload`: file upload from the dashboard, same pipeline and limits,
 *   behind the dashboard session and its CSRF token (S6), in every environment.
 *
 * Middleware order: rate limit → credentials → query validation → content type → body
 * parser → pipeline. Unauthenticated or malformed requests are refused before the body is
 * read. Rate limits come from the configuration (`RATE_LIMIT_*_PER_MINUTE`).
 */
import { ingestQuerySchema, type IngestQuery } from '@centinela/shared';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { recordAudit } from '../auth/audit.js';
import { authOf } from '../auth/guard.js';
import type { Auth } from '../auth/index.js';
import type { AppDeps } from '../deps.js';
import { HttpError } from '../http/problem.js';
import { validate } from '../http/validate.js';
import type { IngestSummary } from '../pipeline/types.js';
import { MAX_REJECTION_SAMPLES } from '../pipeline/orchestrator.js';
import { clientIp } from '../security/client-ip.js';
import { createRateLimiter } from '../security/rate-limit.js';
import { requireBearerToken } from './auth.js';
import { decodeBody, mergeRejections, type BodyFormat } from './body.js';

export const INGEST_BODY_LIMIT = '5mb';

const CONTENT_TYPES: Record<string, BodyFormat> = {
  'text/plain': 'text',
  'application/x-ndjson': 'ndjson',
};

const RATE_LIMITED = 'Too many ingest requests; slow down and retry later';

interface IngestLocals {
  query: IngestQuery;
  format: BodyFormat;
}

/** Validates `source`, `host` and `tz` (400) and the content type (415). */
const checkRequest: RequestHandler = (req, res, next) => {
  const query = validate(ingestQuerySchema, req.query, 'query');
  const mediaType = (req.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const format = CONTENT_TYPES[mediaType];
  if (format === undefined) {
    throw new HttpError(415, 'Send the lines as text/plain or application/x-ndjson');
  }
  const locals: IngestLocals = { query, format };
  res.locals.ingest = locals;
  next();
};

const textBody = express.text({
  type: Object.keys(CONTENT_TYPES),
  limit: INGEST_BODY_LIMIT,
});

type AfterIngest = (req: Request, res: Response, summary: IngestSummary) => Promise<void>;

function runPipeline(deps: AppDeps, after?: AfterIngest): RequestHandler {
  return async (req, res) => {
    const { query, format } = res.locals.ingest as IngestLocals;
    const body: unknown = req.body;
    const decoded = decodeBody(typeof body === 'string' ? body : '', format);
    const summary = await deps.pipeline.ingest(decoded.lines, {
      source: query.source,
      host: query.host,
      timezone: query.tz,
      receivedAt: new Date(),
    });
    const merged = mergeRejections(summary, decoded.rejections, MAX_REJECTION_SAMPLES);
    await after?.(req, res, merged);
    res.json(merged);
  };
}

/** Uploads are analyst actions: who sent what, and how much of it was accepted. */
function auditUpload(deps: AppDeps): AfterIngest {
  return async (req, res, summary) => {
    const { query } = res.locals.ingest as IngestLocals;
    await recordAudit(deps.pool, {
      actor: authOf(res).session.username,
      action: 'ingest.upload',
      ip: clientIp(req),
      details: {
        source: query.source,
        host: query.host,
        accepted: summary.accepted,
        rejected: summary.rejected,
      },
    });
  };
}

export function createIngestRouter(
  deps: AppDeps,
  auth: Pick<Auth, 'verifyIngestToken' | 'requireSession' | 'requireCsrf'>,
): Router {
  const { rateLimits } = deps.config;
  const router = Router();
  router.post(
    '/ingest',
    createRateLimiter(rateLimits.ingest, RATE_LIMITED),
    requireBearerToken(auth.verifyIngestToken),
    checkRequest,
    textBody,
    runPipeline(deps),
  );
  router.post(
    '/ingest/upload',
    createRateLimiter(rateLimits.upload, RATE_LIMITED),
    auth.requireSession(),
    auth.requireCsrf,
    checkRequest,
    textBody,
    runPipeline(deps, auditUpload(deps)),
  );
  return router;
}
