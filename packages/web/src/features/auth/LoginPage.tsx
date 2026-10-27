/**
 * Sign-in page (outside the dashboard layout). After signing in the analyst returns to the
 * page they asked for (`?next=`, restricted to dashboard paths).
 */
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from '@centinela/shared';
import { CircleAlert, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client';
import { Lockup } from '../../components/brand/Wordmark';
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
  const [missing, setMissing] = useState(false);

  if (session.data) return <Navigate to={next} replace />;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (username === '' || password === '') {
      setMissing(true);
      return;
    }
    setMissing(false);
    login.mutate(
      { username, password },
      { onSuccess: () => void navigate(next, { replace: true }) },
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap justify-end gap-3 px-4 py-4 md:px-8">
        <LanguageToggle showLabel={false} />
        <ThemeToggle showLabel={false} />
      </header>
      <main id="main" className="flex flex-1 justify-center px-4 pt-[6vh] pb-16">
        <div className="flex w-full max-w-[26rem] flex-col gap-8">
          <div className="flex flex-col gap-4">
            <Lockup size="lg" />
            <p className="text-lead text-muted">{t('auth.login.pitch')}</p>
          </div>
          <section aria-labelledby="sign-in-title" className="answer-frame px-6 py-7 sm:px-8">
            <h1 id="sign-in-title" className="text-title font-semibold text-fg">
              {t('auth.login.title')}
            </h1>
            <p className="mt-1 mb-6 text-muted">{t('auth.login.hint')}</p>
            {session.isPending ? (
              <LoadingState />
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <TextField
                  label={t('auth.login.username')}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={MAX_USERNAME_LENGTH}
                  aria-invalid={(missing && username === '') || undefined}
                  required
                />
                <TextField
                  label={t('auth.login.password')}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  maxLength={MAX_PASSWORD_LENGTH}
                  aria-invalid={(missing && password === '') || undefined}
                  required
                />
                <Button
                  type="submit"
                  variant="primary"
                  icon={LogIn}
                  className="mt-2 w-full"
                  loading={login.isPending}
                >
                  {login.isPending ? t('auth.login.signingIn') : t('auth.login.submit')}
                </Button>
                {missing ? (
                  <p role="alert" className="flex items-start gap-2 font-semibold text-danger">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    {t('auth.login.missing')}
                  </p>
                ) : login.isError ? (
                  <LoginError error={login.error} />
                ) : null}
              </form>
            )}
          </section>
          <p className="text-small text-muted">{t('auth.login.footer')}</p>
        </div>
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
    <p role="alert" className="flex items-start gap-2 font-semibold text-danger">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  );
}
