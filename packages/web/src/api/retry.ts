import { ApiError } from './client';

export const MAX_QUERY_RETRIES = 3;

/**
 * Retry policy for queries against the real API: network failures and `5xx` answers are
 * retried a few times; a `4xx` answer (an unknown alert stays unknown, a bad filter stays
 * bad) or a response that breaks the contract is shown as an error state right away.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (error instanceof ApiError) return error.status >= 500;
  // fetch() rejects with a TypeError when the network or the proxy is unreachable.
  return error instanceof TypeError;
}
