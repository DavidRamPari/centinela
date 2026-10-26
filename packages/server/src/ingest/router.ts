/**
 * Ingest endpoints (ARCHITECTURE §9):
 *
 * - `POST /api/ingest`: for agents and scripts. Bearer token (`INGEST_TOKEN`, compared in
 *   constant time), body `text/plain` lines or `application/x-ndjson`, at most 5 MB.
 * - `POST /api/ingest/upload`: file upload from the dashboard, same pipeline and limits,
 *   no token. Mounted only when `NODE_ENV` is not `production` (so it answers `404`
 *   there); session S6 puts it behind the dashboard session and CSRF.
 *
 * Middleware order: rate limit → token → query validation → content type → body parser →
 * pipeline. Unauthenticated or malformed requests are refused before the body is read.
 */
import { ingestQuerySchema, type IngestQuery } from '@centinela/shared';
import express, { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppDeps } from '../deps.js';
import { HttpError, problem, sendProblem } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { MAX_REJECTION_SAMPLES } from '../pipeline/orchestrator.js';
import { requireBearerToken } from './auth.js';
import { decodeBody, mergeRejections, type BodyFormat } from './body.js';

export const INGEST_BODY_LIMIT = '5mb';

export interface RateLimitOptions {
  windowMs: number;
  /** Requests per client IP per window. */
  limit: number;
}

/** Agents batch their lines, so two requests per second per client is generous. */
export const INGEST_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, limit: 120 };
/** The dashboard uploads files by hand. */
export const UPLOAD_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, limit: 30 };

export interface IngestRouterOptions {
  ingestRateLimit?: RateLimitOptions;
  uploadRateLimit?: RateLimitOptions;
}

const CONTENT_TYPES: Record<string, BodyFormat> = {
  'text/plain': 'text',
  'application/x-ndjson': 'ndjson',
};

function limiter({ windowMs, limit }: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      sendProblem(res, problem(429, 'Too many ingest requests; slow down and retry later'));
    },
  });
}

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

function runPipeline(deps: AppDeps): RequestHandler {
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
    res.json(mergeRejections(summary, decoded.rejections, MAX_REJECTION_SAMPLES));
  };
}

export function createIngestRouter(deps: AppDeps, options: IngestRouterOptions = {}): Router {
  const router = Router();
  router.post(
    '/ingest',
    limiter(options.ingestRateLimit ?? INGEST_RATE_LIMIT),
    requireBearerToken(deps.config.ingestToken),
    checkRequest,
    textBody,
    runPipeline(deps),
  );
  if (!deps.config.isProduction) {
    router.post(
      '/ingest/upload',
      limiter(options.uploadRateLimit ?? UPLOAD_RATE_LIMIT),
      checkRequest,
      textBody,
      runPipeline(deps),
    );
  }
  return router;
}
