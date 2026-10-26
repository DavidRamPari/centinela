import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../src/api/client';
import { MAX_QUERY_RETRIES, shouldRetryQuery } from '../src/api/retry';
import { createQueryClient } from '../src/app/query-client';

const problem = (status: number) => ({ type: 'about:blank', title: 'Error', status });

describe('query retry policy', () => {
  it.each([400, 404, 409, 429])('never retries a %i answer', (status) => {
    expect(shouldRetryQuery(0, new ApiError(status, problem(status)))).toBe(false);
  });

  it.each([500, 502, 503])('retries a %i answer up to the limit', (status) => {
    const error = new ApiError(status, problem(status));
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, error)).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, error)).toBe(false);
  });

  it('retries network failures but not responses that break the contract', () => {
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true);
    const contract = z.object({ id: z.string() }).safeParse({});
    expect(shouldRetryQuery(0, contract.error)).toBe(false);
  });

  it('is the default of the app query client', () => {
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(shouldRetryQuery);
  });
});
