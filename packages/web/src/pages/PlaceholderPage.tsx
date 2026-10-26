import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/ui/PageHeader';

export type PlaceholderPageKey = 'overview' | 'alerts' | 'events' | 'attack' | 'rules' | 'ingest';

/** Placeholder for the views session S3 builds. */
export function PlaceholderPage({ page }: { page: PlaceholderPageKey }) {
  const { t } = useTranslation();
  return (
    <section>
      <PageHeader title={t(`pages.${page}.title`)} description={t(`pages.${page}.description`)} />
      <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400">
        {t('pages.placeholder')}
      </div>
    </section>
  );
}
