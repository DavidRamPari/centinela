import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '../components/ui/PageHeader';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <section>
      <PageHeader title={t('pages.notFound.title')} description={t('pages.notFound.description')} />
      <Link to="/" className="text-accent-400 underline">
        {t('pages.notFound.back')}
      </Link>
    </section>
  );
}
