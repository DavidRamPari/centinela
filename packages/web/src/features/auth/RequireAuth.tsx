/**
 * Gate for every dashboard route: shows the page only with a live session, otherwise sends
 * the analyst to the sign-in page with `?next=` pointing back here. Any `401` from the API
 * (the session expired or was signed out elsewhere) clears the cached data and redirects.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { onUnauthorized } from '../../api/client';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { authKeys, useSession } from './hooks';
import { loginPath } from './next-path';

export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      onUnauthorized(() => {
        // Drop everything fetched with the old session, then let the gate redirect.
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
        queryClient.setQueryData(authKeys.session, null);
      }),
    [queryClient],
  );

  if (session.isPending) return <LoadingState />;
  if (session.isError) {
    return (
      <main className="p-6">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </main>
    );
  }
  if (session.data === null) {
    return <Navigate to={loginPath(`${location.pathname}${location.search}`)} replace />;
  }
  return children;
}
