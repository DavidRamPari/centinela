import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { useDocumentTitle } from '../lib/document-title';

export function NotFoundPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('pages.notFound.title'));
  return (
    <section>
      <PageHeader title={t('pages.notFound.title')} description={t('pages.notFound.description')} />
      <Link
        to="/"
        className="text-link underline decoration-line-strong underline-offset-3 hover:decoration-link"
      >
        {t('pages.notFound.back')}
      </Link>
    </section>
  );
}
