import type { Alert, RuleMeta } from '@centinela/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { DescriptionList } from '../../components/ui/DescriptionList';
import { ExternalLink } from '../../components/ui/ExternalLink';
import { Section } from '../../components/ui/Section';
import { DRL_URL } from '../../lib/links';

/** License with its link; DRL 1.1 requires showing the author and a link to the rule. */
export function LicenseValue({ license }: { license: 'DRL-1.1' | 'MIT' | null }) {
  const { t } = useTranslation();
  if (license === 'DRL-1.1')
    return <ExternalLink href={DRL_URL}>{t('rules.license.drl')}</ExternalLink>;
  if (license === 'MIT') return <span>{t('rules.license.mit')}</span>;
  return <span className="text-muted">{t('common.none')}</span>;
}

/** The rule behind an alert, with the attribution DRL 1.1 requires (CLAUDE.md). */
export function RulePanel({ alert, rule }: { alert: Alert; rule: RuleMeta | null }) {
  const { t } = useTranslation();
  return (
    <Section title={t('alertDetail.rule.title')} divider>
      {rule === null ? <p className="text-muted">{t('alertDetail.rule.missing')}</p> : null}
      <DescriptionList
        items={[
          {
            term: t('rules.fields.name'),
            value: (
              <Link
                to={`/rules/${alert.ruleId}`}
                className="text-link underline decoration-line-strong underline-offset-3 hover:decoration-link"
              >
                {alert.ruleTitle}
              </Link>
            ),
          },
          { term: t('rules.fields.type'), value: t(`ruleTypes.${alert.ruleType}`) },
          { term: t('rules.fields.author'), value: alert.author ?? t('common.none') },
          {
            term: t('rules.fields.link'),
            value: alert.ruleUrl ? (
              <ExternalLink href={alert.ruleUrl}>{t('rules.viewSource')}</ExternalLink>
            ) : (
              <span className="text-muted">{t('rules.noLink')}</span>
            ),
          },
          { term: t('rules.fields.license'), value: <LicenseValue license={alert.license} /> },
          ...(rule && rule.falsepositives.length > 0
            ? [
                {
                  term: t('rules.fields.falsepositives'),
                  value: (
                    <ul className="flex list-disc flex-col gap-1 pl-4 marker:text-muted">
                      {rule.falsepositives.map((fp) => (
                        <li key={fp}>{fp}</li>
                      ))}
                    </ul>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Section>
  );
}
