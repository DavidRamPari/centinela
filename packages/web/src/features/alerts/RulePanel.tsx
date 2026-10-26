import type { Alert, RuleMeta } from '@centinela/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card } from '../../components/ui/Card';
import { DescriptionList } from '../../components/ui/DescriptionList';
import { ExternalLink } from '../../components/ui/ExternalLink';
import { DRL_URL } from '../../lib/links';

/** License with its link; DRL 1.1 requires showing the author and a link to the rule. */
export function LicenseValue({ license }: { license: 'DRL-1.1' | 'MIT' | null }) {
  const { t } = useTranslation();
  if (license === 'DRL-1.1')
    return <ExternalLink href={DRL_URL}>{t('rules.license.drl')}</ExternalLink>;
  if (license === 'MIT') return <span>{t('rules.license.mit')}</span>;
  return <span className="text-muted">—</span>;
}

/** The rule behind an alert, with the attribution DRL 1.1 requires (CLAUDE.md). */
export function RulePanel({ alert, rule }: { alert: Alert; rule: RuleMeta | null }) {
  const { t } = useTranslation();
  return (
    <Card title={t('alertDetail.rule.title')}>
      <div className="flex flex-col gap-3">
        <Link to={`/rules/${alert.ruleId}`} className="font-medium text-accent hover:underline">
          {alert.ruleTitle}
        </Link>
        {rule?.description ? <p className="text-muted">{rule.description}</p> : null}
        {rule === null ? <p className="text-muted">{t('alertDetail.rule.missing')}</p> : null}
        <DescriptionList
          items={[
            { term: t('rules.fields.type'), value: t(`ruleTypes.${alert.ruleType}`) },
            { term: t('rules.fields.author'), value: alert.author ?? '—' },
            {
              term: t('rules.fields.link'),
              value: alert.ruleUrl ? (
                <ExternalLink href={alert.ruleUrl}>{t('rules.viewSource')}</ExternalLink>
              ) : (
                <span className="text-muted">{t('rules.noLink')}</span>
              ),
            },
            { term: t('rules.fields.license'), value: <LicenseValue license={alert.license} /> },
          ]}
        />
        {rule && rule.falsepositives.length > 0 ? (
          <div>
            <h3 className="text-xs font-medium text-muted">{t('rules.fields.falsepositives')}</h3>
            <ul className="ml-4 list-disc">
              {rule.falsepositives.map((fp) => (
                <li key={fp}>{fp}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
