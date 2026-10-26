/**
 * RFC 9457 problem details (`application/problem+json`) for every API error
 * (ARCHITECTURE §9). Handlers throw `HttpError`; the error handler renders it.
 */
import { STATUS_CODES } from 'node:http';
import type { Problem } from '@centinela/shared';
import type { Response } from 'express';
import type { ZodError } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type ProblemFieldError = NonNullable<Problem['errors']>[number];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
    readonly errors?: ProblemFieldError[],
  ) {
    super(detail ?? STATUS_CODES[status] ?? 'Error');
    this.name = 'HttpError';
  }
}

export function problem(status: number, detail?: string, errors?: ProblemFieldError[]): Problem {
  return {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
  };
}

export function sendProblem(res: Response, body: Problem): void {
  res.status(body.status).type(PROBLEM_CONTENT_TYPE).json(body);
}

/** Field errors from a zod error, without echoing the rejected input. */
export function zodFieldErrors(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
