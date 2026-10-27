import { useTranslation } from 'react-i18next';
import { useHealth } from '../../api/hooks';
import { StatusLine, type StatusTone } from './StatusLine';

/** API and database status, as a status line (icon plus text). */
export function HealthBadge() {
  const { t } = useTranslation();
  const health = useHealth();

  let label: string;
  let tone: StatusTone;
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

  return (
    <span role="status">
      <StatusLine tone={tone}>{label}</StatusLine>
    </span>
  );
}
