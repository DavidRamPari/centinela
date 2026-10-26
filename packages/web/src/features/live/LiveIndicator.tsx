import { clsx } from 'clsx';
import { Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLiveStatus } from './live-context';

/** Connection state of the live stream, as icon plus text. */
export function LiveIndicator() {
  const { t } = useTranslation();
  const status = useLiveStatus();
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 text-xs',
        status === 'live' ? 'text-success' : 'text-muted',
      )}
    >
      <Radio aria-hidden="true" className="size-4" />
      {t(`live.status.${status}`)}
    </span>
  );
}
