import { useTranslation } from 'react-i18next';
import { StatusLine } from '../../components/ui/StatusLine';
import { useLiveStatus } from './live-context';

/** Connection state of the live stream, as a status line (icon plus text). */
export function LiveIndicator() {
  const { t } = useTranslation();
  const status = useLiveStatus();
  return (
    <StatusLine tone={status === 'live' ? 'ok' : 'pending'}>
      {t(`live.status.${status}`)}
    </StatusLine>
  );
}
