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
      <div className="flex flex-col gap-12">
        <IngestTokensCard />
        <AuditLogCard />
      </div>
    </section>
  );
}
