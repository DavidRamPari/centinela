import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../logger.js';
import { HttpError, problem, sendProblem, zodFieldErrors } from './problem.js';

/** Body-parser and http-errors style errors carry a numeric `status` and a `type`. */
function clientErrorOf(err: unknown): { status: number; type: string | undefined } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, type } = err as { status?: unknown; type?: unknown };
  if (typeof status !== 'number' || status < 400 || status > 499) return undefined;
  return { status, type: typeof type === 'string' ? type : undefined };
}

const BODY_ERROR_DETAILS: Record<string, string> = {
  'entity.too.large': 'Request body is too large',
  'entity.parse.failed': 'Request body is not valid JSON',
  'encoding.unsupported': 'Unsupported content encoding',
  'charset.unsupported': 'Unsupported charset',
};

/** `404` problem for any route nobody handled. */
export const notFoundHandler: RequestHandler = (req, res) => {
  sendProblem(res, problem(404, `No route for ${req.method} ${req.path}`));
};

/** Renders every error as problem+json; server errors never leak internals to the client. */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      sendProblem(res, problem(err.status, err.detail, err.errors));
      return;
    }
    if (err instanceof ZodError) {
      sendProblem(res, problem(400, 'Invalid request', zodFieldErrors(err)));
      return;
    }
    const clientError = clientErrorOf(err);
    if (clientError) {
      const detail =
        clientError.type === undefined ? undefined : BODY_ERROR_DETAILS[clientError.type];
      sendProblem(res, problem(clientError.status, detail));
      return;
    }
    logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
    sendProblem(res, problem(500, 'An unexpected error occurred'));
  };
}
