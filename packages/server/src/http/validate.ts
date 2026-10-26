import type { z } from 'zod';
import { HttpError, zodFieldErrors } from './problem.js';

/**
 * Parse untrusted input (query, params, body) with a zod schema, or throw a `400`
 * problem listing the invalid fields.
 */
export function validate<T extends z.ZodType>(
  schema: T,
  input: unknown,
  what = 'request',
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, `Invalid ${what}`, zodFieldErrors(result.error));
  }
  return result.data;
}
