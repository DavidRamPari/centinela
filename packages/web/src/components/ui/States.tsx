import { CircleAlert, Inbox, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
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

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const detail =
    error instanceof ApiError
      ? t('common.errorStatus', { status: error.status, message: error.message })
      : t('common.errorGeneric');
  return (
    <div role="alert" className="flex items-start gap-3 border-l-2 border-danger py-2 pl-4">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="font-semibold text-fg">{t('common.error')}</p>
        <p className="break-words text-muted">{detail}</p>
        {onRetry ? (
          <Button size="sm" className="mt-2" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
