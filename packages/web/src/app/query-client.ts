import { QueryClient } from '@tanstack/react-query';
import { shouldRetryQuery } from '../api/retry';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: shouldRetryQuery },
    },
  });
}
