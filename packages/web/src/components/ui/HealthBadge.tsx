import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useHealth } from '../../api/hooks';

/** API and database status; icon plus text, never color alone. */
export function HealthBadge() {
  const { t } = useTranslation();
  const health = useHealth();

  let label: string;
  let tone: 'ok' | 'warn' | 'pending';
  if (health.isPending) {
    label = t('health.checking');
    tone = 'pending';
  } else if (health.isError) {
    label = t('health.unreachable');
    tone = 'warn';
  } else if (health.data.status === 'ok') {
    label = t('health.ok');
    tone = 'ok';
  } else {
    label = t('health.degraded');
    tone = 'warn';
  }

  const Icon = tone === 'ok' ? CircleCheck : tone === 'warn' ? CircleAlert : LoaderCircle;
  return (
    <span
      role="status"
      className={clsx(
        'inline-flex items-center gap-1.5 text-xs',
        tone === 'ok' && 'text-emerald-300',
        tone === 'warn' && 'text-amber-300',
        tone === 'pending' && 'text-slate-400',
      )}
    >
      <Icon aria-hidden="true" className={clsx('size-4', tone === 'pending' && 'animate-spin')} />
      {label}
    </span>
  );
}
