/** Security: ingest tokens for agents and the audit log of analyst actions. */
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui/PageHeader';
import { AuditLogCard } from './AuditLogCard';
import { IngestTokensCard } from './IngestTokensCard';

export default function SecurityPage() {
  const { t } = useTranslation();
  return (
    <section>
      <PageHeader title={t('auth.security.title')} description={t('auth.security.description')} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <IngestTokensCard />
        <AuditLogCard />
      </div>
    </section>
  );
}
