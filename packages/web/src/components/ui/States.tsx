import { CircleAlert, Inbox, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Button } from './Button';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-muted">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      {label ?? t('common.loading')}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line p-8 text-center">
      <Inbox aria-hidden="true" className="size-6 text-muted" />
      <p className="font-medium text-fg">{title}</p>
      {description ? <p className="text-muted">{description}</p> : null}
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
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-danger p-4 text-fg"
    >
      <p className="flex items-center gap-2 font-medium text-danger">
        <CircleAlert aria-hidden="true" className="size-4" />
        {t('common.error')}
      </p>
      <p className="text-muted">{detail}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}
