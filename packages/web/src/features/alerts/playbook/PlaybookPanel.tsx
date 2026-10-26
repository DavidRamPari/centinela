import type { PlaybookResponse } from '@centinela/shared';
import { BookOpen, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../../components/ui/Card';
import { DescriptionList } from '../../../components/ui/DescriptionList';
import { ExternalLink } from '../../../components/ui/ExternalLink';
import { ErrorState, LoadingState } from '../../../components/ui/States';
import { isLanguage } from '../../../i18n';
import { useFormat } from '../../../lib/format';
import { LicenseValue } from '../RulePanel';
import { usePlaybook } from './use-playbook';

/**
 * Playbook for a rule, from the content pack (session S7): summary, what the rule detects,
 * why it matters, triage steps, false positives, response steps and the reason for its
 * level, in the UI language. The content is AI-generated from a SigmaHQ rule, so the panel
 * says so and carries the rule's attribution (author, link, DRL 1.1). Rules without a
 * playbook (Centinela's own, and the few the generator skipped) show an empty state.
 * Everything is rendered as text.
 */
export function PlaybookPanel({ ruleId }: { ruleId: string }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const query = usePlaybook(ruleId, isLanguage(language) ? language : 'en');

  return (
    <Card title={t('playbook.title')}>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data === null ? (
        <div
          data-rule-id={ruleId}
          className="flex items-start gap-2 rounded-md border border-dashed border-line p-3 text-muted"
        >
          <BookOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>{t('playbook.empty')}</p>
        </div>
      ) : (
        <PlaybookContent data={query.data} />
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Steps({ items, ordered }: { items: readonly string[]; ordered: boolean }) {
  const List = ordered ? 'ol' : 'ul';
  return (
    <List className={ordered ? 'ml-5 list-decimal space-y-1' : 'ml-5 list-disc space-y-1'}>
      {items.map((item, index) => (
        // Items may repeat and the list never changes order: the position is the identity.
        <li key={index}>{item}</li>
      ))}
    </List>
  );
}

function PlaybookContent({ data }: { data: PlaybookResponse }) {
  const { t } = useTranslation();
  const format = useFormat();
  const { playbook, rule, generated } = data;
  return (
    <div className="flex flex-col gap-4" lang={data.lang}>
      <div role="note" className="flex items-start gap-2 rounded-md border border-warn p-3 text-fg">
        <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
        <div>
          <p className="font-medium">{t('playbook.aiLabel')}</p>
          <p className="text-muted">{t('playbook.aiHint')}</p>
        </div>
      </div>
      <p className="text-fg">{playbook.summary}</p>
      <Section title={t('playbook.sections.whatItDetects')}>
        <p>{playbook.whatItDetects}</p>
      </Section>
      <Section title={t('playbook.sections.whyItMatters')}>
        <p>{playbook.whyItMatters}</p>
      </Section>
      <Section title={t('playbook.sections.triageSteps')}>
        <Steps items={playbook.triageSteps} ordered />
      </Section>
      <Section title={t('playbook.sections.falsePositives')}>
        <Steps items={playbook.falsePositives} ordered={false} />
      </Section>
      <Section title={t('playbook.sections.responseSteps')}>
        <Steps items={playbook.responseSteps} ordered />
      </Section>
      <Section title={t('playbook.sections.severityRationale')}>
        <p>{playbook.severityRationale}</p>
      </Section>
      <div className="border-t border-line pt-3 text-xs">
        <DescriptionList
          items={[
            {
              term: t('playbook.attribution.rule'),
              value: rule.url ? (
                <ExternalLink href={rule.url}>{rule.title}</ExternalLink>
              ) : (
                rule.title
              ),
            },
            { term: t('rules.fields.author'), value: rule.author ?? '—' },
            { term: t('rules.fields.license'), value: <LicenseValue license={rule.license} /> },
            {
              term: t('playbook.attribution.generated'),
              value: t('playbook.attribution.generatedValue', {
                model: generated.model,
                date: format.dateTime(generated.at),
              }),
            },
            {
              term: t('playbook.attribution.review'),
              value:
                generated.review === 'unreviewed'
                  ? t('playbook.attribution.unreviewed')
                  : t('playbook.attribution.reviewStatus', { status: generated.review }),
            },
          ]}
        />
      </div>
    </div>
  );
}
