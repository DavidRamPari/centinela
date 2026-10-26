/** Signed-in analyst and the sign-out button, in the dashboard header. */
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { useToasts } from '../../components/ui/toast-context';
import { authKeys, useLogout, useSession } from './hooks';

export function SessionMenu() {
  const { t } = useTranslation();
  const session = useSession();
  const logout = useLogout();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { push } = useToasts();

  function signedOut() {
    void navigate('/login', { replace: true });
    queryClient.clear();
    queryClient.setQueryData(authKeys.session, null);
  }

  if (!session.data) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1 text-xs text-muted">
        <UserRound aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{t('auth.session.signedInAs')}</span>
        <span className="font-mono text-fg">{session.data.username}</span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={logout.isPending}
        onClick={() =>
          logout.mutate(undefined, {
            onSuccess: signedOut,
            onError: (error) => {
              // Already signed out on the server (expired session): same outcome.
              if (error instanceof ApiError && error.status === 401) signedOut();
              else push({ title: t('auth.session.signOutFailed') });
            },
          })
        }
      >
        <LogOut aria-hidden="true" className="size-3.5" />
        {t('auth.session.signOut')}
      </Button>
    </div>
  );
}
