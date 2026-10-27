import { clsx } from 'clsx';
import { CircleAlert, Inbox, LoaderCircle, RotateCw, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useErrorText } from '../../lib/error-text';
import { Button } from './Button';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-muted">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      {label ?? t('common.loading')}
    </div>
  );
}

/**
 * Nothing to show, said calmly: what is going on and what to do next. An empty list is a
 * normal state, never an error (docs/decisions/S7b.md).
 */
export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  compact = false,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'flex items-start gap-3 py-2' : 'flex items-start gap-4 py-8'}>
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className={compact ? 'mt-0.5 size-5 shrink-0 text-info' : 'size-8 shrink-0 text-info'}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-fg">{title}</p>
        {description ? <div className="max-w-prose text-muted">{description}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * A load failed and there is nothing to show: what happened, what to do about it, and a
 * retry. Used only when a query has no data; a failed refresh keeps the data on screen
 * with a `RefreshFailed` notice instead.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => unknown }) {
  const text = useErrorText(error);
  return (
    <div role="alert" className="flex items-start gap-3 border-l-2 border-danger py-2 pl-4">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="font-semibold text-fg">{text.title}</p>
        <p className="max-w-prose text-fg">{text.action}</p>
        {text.detail ? <p className="break-words text-small text-muted">{text.detail}</p> : null}
        {onRetry ? <RetryButton onRetry={onRetry} className="mt-2" /> : null}
      </div>
    </div>
  );
}

/**
 * A refresh failed but the last data is still on screen: say so in one line above it,
 * with a retry, instead of replacing the page with an error.
 */
export function RefreshFailed({ error, onRetry }: { error: unknown; onRetry: () => unknown }) {
  const { t } = useTranslation();
  const text = useErrorText(error);
  return (
    <div
      role="alert"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-danger py-1 pl-3"
    >
      <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-danger" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold text-fg">{t('common.refreshFailed')}</span>{' '}
        <span className="text-muted">{text.action}</span>
      </p>
      <RetryButton onRetry={onRetry} />
    </div>
  );
}

/** "Try again", busy until the retry settles, so a second click does not queue another. */
function RetryButton({ onRetry, className }: { onRetry: () => unknown; className?: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      icon={RotateCw}
      className={className}
      loading={busy}
      onClick={() => {
        setBusy(true);
        void Promise.resolve(onRetry()).finally(() => setBusy(false));
      }}
    >
      {t('common.retry')}
    </Button>
  );
}

/**
 * While a new filter or range loads, the previous answer stays on screen instead of a
 * skeleton: marked busy, and dimmed only after 200 ms, so a fast answer never flickers.
 */
export function Updating({
  active,
  className,
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-busy={active || undefined}
      data-updating={active || undefined}
      className={clsx(
        'transition-opacity duration-150 ease-out',
        active && 'opacity-60 delay-200',
        className,
      )}
    >
      {children}
    </div>
  );
}
