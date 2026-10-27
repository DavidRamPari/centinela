import type { PlaybookResponse, RuleMeta } from '@centinela/shared';
import { BookOpen, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DescriptionList } from '../../../components/ui/DescriptionList';
import { ExternalLink } from '../../../components/ui/ExternalLink';
import { LoadingRegion, SkeletonLines, SkeletonText } from '../../../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../../../components/ui/States';
import { isLanguage } from '../../../i18n';
import { useFormat } from '../../../lib/format';
import { LicenseValue } from '../RulePanel';
import { usePlaybook } from './use-playbook';

/**
 * Playbook for a rule, from the content pack (session S7): summary, what the rule detects,
 * why it matters, triage steps, false positives, response steps and the reason for its
 * level, in the UI language. The content is AI-generated from a SigmaHQ rule, so the panel
 * says so up front and carries the rule's attribution (author, link, DRL 1.1). A rule
 * without a playbook (Centinela's own rules, whose playbooks come in a later change, and
 * the few SigmaHQ rules the generator skipped) gets a calm explanation, not an error.
 * Everything is rendered as text.
 */
export function PlaybookPanel({
  ruleId,
  origin,
}: {
  ruleId: string;
  /** Who wrote the rule; picks the explanation when there is no playbook. */
  origin?: RuleMeta['origin'];
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const query = usePlaybook(ruleId, isLanguage(language) ? language : 'en');

  return (
    <section aria-labelledby="playbook-title" className="flex flex-col gap-4">
      <h3 id="playbook-title" className="text-lead font-semibold text-fg">
        {t('playbook.title')}
      </h3>
      {query.isPending ? (
        <PlaybookSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data === null ? (
        <div data-rule-id={ruleId}>
          <EmptyState
            compact
            icon={BookOpen}
            title={t(
              origin === 'centinela' ? 'playbook.empty.centinelaTitle' : 'playbook.empty.title',
            )}
            description={t(
              origin === 'centinela' ? 'playbook.empty.centinela' : 'playbook.empty.sigmahq',
            )}
          />
        </div>
      ) : (
        <PlaybookContent data={query.data} />
      )}
    </section>
  );
}

/** A summary paragraph and two short sections, the shape most playbooks start with. */
function PlaybookSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('playbook.loading')} className="flex flex-col gap-5">
      <SkeletonLines lines={3} />
      {[0, 1].map((index) => (
        <span key={index} className="flex flex-col gap-1.5" aria-hidden="true">
          <SkeletonText className="w-1/3" />
          <SkeletonLines lines={2} />
        </span>
      ))}
    </LoadingRegion>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="font-semibold text-fg">{title}</h4>
      {children}
    </section>
  );
}

function Steps({ items, ordered }: { items: readonly string[]; ordered: boolean }) {
  if (!ordered) {
    return (
      <ul className="flex list-disc flex-col gap-1.5 pl-5 marker:text-muted">
        {items.map((item, index) => (
          // Items may repeat and the list never changes order: the position is the identity.
          <li key={index}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, index) => (
        <li key={index} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-1">
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-badge border border-line-strong text-small font-semibold text-fg"
          >
            {index + 1}
          </span>
          <span className="pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function PlaybookContent({ data }: { data: PlaybookResponse }) {
  const { t } = useTranslation();
  const format = useFormat();
  const { playbook, rule, generated } = data;
  return (
    <div className="flex flex-col gap-6" lang={data.lang}>
      <div
        role="note"
        className="flex items-start gap-3 rounded-control border border-line-strong px-4 py-3"
      >
        <Sparkles
          aria-hidden="true"
          strokeWidth={1.75}
          className="mt-0.5 size-5 shrink-0 text-fg"
        />
        <div>
          <p className="font-semibold text-fg">{t('playbook.aiLabel')}</p>
          <p className="text-muted">{t('playbook.aiHint')}</p>
        </div>
      </div>
      <p className="text-lead text-fg">{playbook.summary}</p>
      <Part title={t('playbook.sections.triageSteps')}>
        <Steps items={playbook.triageSteps} ordered />
      </Part>
      <Part title={t('playbook.sections.responseSteps')}>
        <Steps items={playbook.responseSteps} ordered />
      </Part>
      <Part title={t('playbook.sections.falsePositives')}>
        <Steps items={playbook.falsePositives} ordered={false} />
      </Part>
      <Part title={t('playbook.sections.whatItDetects')}>
        <p>{playbook.whatItDetects}</p>
      </Part>
      <Part title={t('playbook.sections.whyItMatters')}>
        <p>{playbook.whyItMatters}</p>
      </Part>
      <Part title={t('playbook.sections.severityRationale')}>
        <p>{playbook.severityRationale}</p>
      </Part>
      <div className="border-t border-line pt-4 text-small">
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
            { term: t('rules.fields.author'), value: rule.author ?? t('common.none') },
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
