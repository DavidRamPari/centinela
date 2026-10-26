import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export const queryKeys = {
  health: ['health'] as const,
};

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 30_000,
    retry: false,
  });
}
