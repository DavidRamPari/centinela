/**
 * Sign-in page (outside the dashboard layout). After signing in the analyst returns to the
 * page they asked for (`?next=`, restricted to dashboard paths).
 */
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from '@centinela/shared';
import { LogIn, ShieldHalf } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Fields';
import { LanguageToggle } from '../../components/ui/LanguageToggle';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { ThemeToggle } from '../../components/ui/ThemeToggle';
import { useLogin, useSession } from './hooks';
import { safeNextPath } from './next-path';

export default function LoginPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const session = useSession();
  const login = useLogin();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  if (session.data) return <Navigate to={next} replace />;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (username === '' || password === '') return;
    login.mutate(
      { username, password },
      { onSuccess: () => void navigate(next, { replace: true }) },
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex justify-end gap-3 px-4 py-2">
        <ThemeToggle />
        <LanguageToggle />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pt-[10vh]">
        <section className="w-full max-w-sm rounded-lg border border-line bg-surface p-6">
          <div className="mb-6 flex items-center gap-2">
            <ShieldHalf aria-hidden="true" className="size-7 text-accent" />
            <div>
              <p className="font-semibold text-fg">{t('app.name')}</p>
              <p className="text-xs text-muted">{t('app.tagline')}</p>
            </div>
          </div>
          <h1 className="mb-4 text-lg font-semibold text-fg">{t('auth.login.title')}</h1>
          {session.isPending ? (
            <LoadingState />
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
              <TextField
                label={t('auth.login.username')}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={MAX_USERNAME_LENGTH}
                required
              />
              <TextField
                label={t('auth.login.password')}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                maxLength={MAX_PASSWORD_LENGTH}
                required
              />
              <Button
                type="submit"
                variant="primary"
                disabled={login.isPending || username === '' || password === ''}
              >
                <LogIn aria-hidden="true" className="size-4" />
                {login.isPending ? t('auth.login.signingIn') : t('auth.login.submit')}
              </Button>
              {login.isError ? <LoginError error={login.error} /> : null}
            </form>
          )}
        </section>
      </main>
    </div>
  );
}

function LoginError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!(error instanceof ApiError) || ![401, 429, 503].includes(error.status)) {
    return <ErrorState error={error} />;
  }
  const message =
    error.status === 401
      ? t('auth.login.invalid')
      : error.status === 503
        ? t('auth.login.busy')
        : t('auth.login.locked', { minutes: Math.ceil((error.retryAfterSeconds ?? 60) / 60) });
  return (
    <p role="alert" className="text-danger">
      {message}
    </p>
  );
}
