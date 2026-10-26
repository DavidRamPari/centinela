import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../../components/ui/Card';

/**
 * Playbook for the alert's rule. Reserved for session S7, which owns this folder and loads
 * the content pack (`GET /api/rules/:id/playbook`); until then it is an empty panel.
 */
export function PlaybookPanel({ ruleId }: { ruleId: string }) {
  const { t } = useTranslation();
  return (
    <Card title={t('playbook.title')}>
      <div
        data-rule-id={ruleId}
        className="flex items-start gap-2 rounded-md border border-dashed border-line p-3 text-muted"
      >
        <BookOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>{t('playbook.empty')}</p>
      </div>
    </Card>
  );
}
