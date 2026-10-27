import type { Entities } from '@centinela/shared';
import { useTranslation } from 'react-i18next';
import { Truncate } from '../../components/ui/Truncate';

/** Compact entity summary for tables: IPs first, then users. Text only. */
export function EntitySummary({ entities }: { entities: Entities }) {
  const { t } = useTranslation();
  const items = [...entities.ips, ...entities.users];
  if (items.length === 0) return <span className="text-muted">{t('common.none')}</span>;
  const shown = items.slice(0, 2).join(', ');
  const more = items.length > 2 ? ` ${t('common.more', { value: items.length - 2 })}` : '';
  return <Truncate text={`${shown}${more}`} className="max-w-[16rem]" />;
}
