/** TanStack Query hooks for the session, ingest tokens and the audit log. */
import type { SessionInfo } from '@centinela/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, type QueryParams } from '../../api/client';
import { authApi } from './api';

export const authKeys = {
  session: ['auth', 'session'] as const,
  tokens: ['auth', 'tokens'] as const,
  audit: (params: QueryParams) => ['auth', 'audit', params] as const,
};

/** How often the dashboard checks that its session is still alive (does not extend it). */
export const SESSION_CHECK_MS = 60_000;

/** The signed-in analyst, or `null` when signed out. */
export function useSession() {
  return useQuery({
    queryKey: authKeys.session,
    queryFn: async ({ signal }): Promise<SessionInfo | null> => {
      try {
        return await authApi.me(signal);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    refetchInterval: SESSION_CHECK_MS,
    staleTime: SESSION_CHECK_MS,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.login,
    onSuccess: (session) => {
      queryClient.setQueryData(authKeys.session, session);
    },
  });
}

export function useLogout() {
  return useMutation({ mutationFn: authApi.logout });
}

export function useTokens() {
  return useQuery({
    queryKey: authKeys.tokens,
    queryFn: ({ signal }) => authApi.listTokens(signal),
  });
}

/** Token and audit changes both show up in the audit log. */
function useInvalidateSecurity() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: authKeys.tokens }),
      queryClient.invalidateQueries({ queryKey: ['auth', 'audit'] }),
    ]);
}

export function useCreateToken() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: authApi.createToken, onSuccess: invalidate });
}

export function useRevokeToken() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: authApi.revokeToken, onSuccess: invalidate });
}

export function useAuditLog(params: QueryParams) {
  return useInfiniteQuery({
    queryKey: authKeys.audit(params),
    queryFn: ({ pageParam, signal }) => authApi.listAudit({ ...params, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // A new action filter keeps the last entries on screen while it loads (S7b-17).
    placeholderData: keepPreviousData,
  });
}
