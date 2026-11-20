/**
 * Ingest endpoints (ARCHITECTURE §9):
 *
 * - `POST /api/ingest`: for agents and scripts. Bearer token (`INGEST_TOKEN`, compared in
 *   constant time, or an active token created in the dashboard), body `text/plain` lines or
 *   `application/x-ndjson`, at most 5 MB once decoded, optionally `Content-Encoding: gzip`.
 *   `ack=stored` answers once the events are stored and leaves their evaluation to the
 *   reorder buffer (ARCHITECTURE §6.2). A scoped token sends only its sources and hosts.
 * - `POST /api/ingest/upload`: file upload from the dashboard, same pipeline and limits,
 *   behind the dashboard session and its CSRF token (S6), in every environment.
 *
 * `/api/ingest` checks, in order: the client address's budget for requests without a
 * valid token (429) → credentials (401) → the token's own budget (429) → query (400) →
 * content type and encoding (415) → the token's scope (403) → requests in progress (503)
 * → body (413) → pipeline. Everything before the body parser answers without reading the
 * body. Budgets come from the configuration (`RATE_LIMIT_*_PER_MINUTE`, `INGEST_MAX_PENDING`).
 */
import { ingestQuerySchema, type IngestQuery } from '@centinela/shared';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { recordAudit } from '../auth/audit.js';
import { authOf } from '../auth/guard.js';
import type { Auth } from '../auth/index.js';
import type { AppDeps } from '../deps.js';
import { HttpError, problem, sendProblem } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { parserInputOf } from '../parsers/index.js';
import { StreamLimitError, type IngestSummary, type StreamKind } from '../pipeline/types.js';
import { MAX_REJECTION_SAMPLES } from '../pipeline/orchestrator.js';
import { clientIp } from '../security/client-ip.js';
import { createRateLimiter, createWindowCounter, sendRateLimited } from '../security/rate-limit.js';
import { credentialOf, requireBearerToken } from './auth.js';
import { decodeBody, mergeRejections, type BodyFormat } from './body.js';
import { allowsHost, allowsSource } from './scope.js';

export const INGEST_BODY_LIMIT = '5mb';

const CONTENT_TYPES: Record<string, BodyFormat> = {
  'text/plain': 'text',
  'application/x-ndjson': 'ndjson',
};

const RATE_LIMITED = 'Too many ingest requests; slow down and retry later';
const BUSY = 'Centinela is behind; retry after the time in Retry-After';
/** What a busy server asks a shipper to wait; one batch takes about a second or less. */
export const BUSY_RETRY_AFTER_SECONDS = 5;
const ENCODINGS = new Set(['identity', 'gzip']);

interface IngestLocals {
  query: IngestQuery;
  format: BodyFormat;
}

/** Validates `source`, `host` and `tz` (400), the content type and its encoding (415). */
const checkRequest: RequestHandler = (req, res, next) => {
  const query = validate(ingestQuerySchema, req.query, 'query');
  const mediaType = (req.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const format = CONTENT_TYPES[mediaType];
  if (format === undefined) {
    throw new HttpError(415, 'Send the lines as text/plain or application/x-ndjson');
  }
  const encoding = (req.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (!ENCODINGS.has(encoding)) {
    throw new HttpError(415, 'Send the body uncompressed or with Content-Encoding: gzip');
  }
  const locals: IngestLocals = { query, format };
  res.locals.ingest = locals;
  next();
};

/** A scoped token sends only its source types and hosts (403, before the body is read). */
const checkScope: RequestHandler = (_req, res, next) => {
  const credential = credentialOf(res.locals);
  const { query } = res.locals.ingest as IngestLocals;
  if (credential !== undefined && !allowsSource(credential, query.source)) {
    throw new HttpError(403, 'This token may not send events of this source');
  }
  if (credential !== undefined && !allowsHost(credential, query.host)) {
    throw new HttpError(403, 'This token may not send events for this host');
  }
  next();
};

/**
 * At most `max` requests past the checks at once: reading their body, waiting for the
 * pipeline (it runs one batch at a time) or being processed. The next is answered `503`
 * with `Retry-After` before its body is read, so a shipper backs off instead of piling up.
 */
function limitInProgress(max: number): RequestHandler {
  let inProgress = 0;
  return (_req, res, next) => {
    if (inProgress >= max) {
      res.set('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
      sendProblem(res, problem(503, BUSY));
      return;
    }
    inProgress += 1;
    res.once('close', () => {
      inProgress -= 1;
    });
    next();
  };
}

/**
 * The body, decoded: `Content-Encoding: gzip` is inflated as it is read, and the limit
 * applies to what it inflates to, so a small body that inflates past it is refused with
 * `413` without buffering more than the limit.
 */
const textBody = express.text({
  type: Object.keys(CONTENT_TYPES),
  limit: INGEST_BODY_LIMIT,
  inflate: true,
});

type AfterIngest = (req: Request, res: Response, summary: IngestSummary) => Promise<void>;

/**
 * `kind` says who delivers (ARCHITECTURE §8.1). Uploads always answer with final counts;
 * a shipper may ask for `ack=stored`.
 */
function runPipeline(deps: AppDeps, kind: StreamKind, after?: AfterIngest): RequestHandler {
  return async (req, res) => {
    const { query, format } = res.locals.ingest as IngestLocals;
    const credential = credentialOf(res.locals);
    const body: unknown = req.body;
    const decoded = decodeBody(
      typeof body === 'string' ? body : '',
      format,
      parserInputOf(query.source),
    );
    let summary: IngestSummary;
    try {
      summary = await deps.pipeline.ingest(decoded.lines, {
        source: query.source,
        host: query.host,
        timezone: query.tz,
        receivedAt: new Date(),
        stream: { kind, tokenId: credential?.id ?? null },
        ack: kind === 'upload' ? 'evaluated' : query.ack,
        // A line that names its own host is held to the token's hosts too (S10-07).
        ...(credential !== undefined && credential.hosts.length > 0
          ? { acceptsHost: (host: string) => allowsHost(credential, host) }
          : {}),
      });
    } catch (err) {
      if (err instanceof StreamLimitError) throw new HttpError(403, err.message);
      throw err;
    }
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
  const { rateLimits, ingest } = deps.config;
  // Requests without a valid token, per client address; authenticated ones, per token.
  const failures = createWindowCounter(rateLimits.auth);
  const perToken = createWindowCounter(rateLimits.ingest);
  const limitPerToken: RequestHandler = (_req, res, next) => {
    const key = credentialOf(res.locals)?.id ?? 'INGEST_TOKEN';
    const wait = perToken.wait(key);
    if (wait > 0) {
      sendRateLimited(res, wait, RATE_LIMITED);
      return;
    }
    perToken.add(key);
    next();
  };
  const router = Router();
  router.post(
    '/ingest',
    requireBearerToken(auth.verifyIngestToken, failures),
    limitPerToken,
    checkRequest,
    checkScope,
    limitInProgress(ingest.maxPending),
    textBody,
    runPipeline(deps, 'token'),
  );
  router.post(
    '/ingest/upload',
    createRateLimiter(rateLimits.upload, RATE_LIMITED),
    auth.requireSession(),
    auth.requireCsrf,
    checkRequest,
    textBody,
    runPipeline(deps, 'upload', auditUpload(deps)),
  );
  return router;
}
