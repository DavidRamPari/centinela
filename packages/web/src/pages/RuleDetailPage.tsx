import type { RuleMeta } from '@centinela/shared';
import { Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { useRule, useUpdateRule } from '../api/hooks';
import { SeverityBadge } from '../components/ui/Badges';
import { Button } from '../components/ui/Button';
import { CopyButton } from '../components/ui/CopyButton';
import { Section } from '../components/ui/Section';
import { CodeBlock } from '../components/ui/CodeBlock';
import { DescriptionList } from '../components/ui/DescriptionList';
import { ExternalLink } from '../components/ui/ExternalLink';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingRegion, Skeleton, SkeletonLines, SkeletonText } from '../components/ui/Skeleton';
import { EmptyState, ErrorState, RefreshFailed } from '../components/ui/States';
import { useToasts } from '../components/ui/toast-context';
import { describeError } from '../lib/error-text';
import { useSingleFlight } from '../lib/single-flight';
import { LicenseValue } from '../features/alerts/RulePanel';
import { PlaybookPanel } from '../features/alerts/playbook/PlaybookPanel';
import { TechniqueList } from '../features/attack/TechniqueLink';

const ruleIdSchema = z.guid();

export default function RuleDetailPage() {
  const { t } = useTranslation();
  const params = useParams();
  const id = ruleIdSchema.safeParse(params.id);
  if (!id.success) {
    return (
      <section>
        <BackLink />
        <EmptyState title={t('ruleDetail.notFound')} />
      </section>
    );
  }
  return <RuleDetail id={id.data} />;
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('common.breadcrumb')}>
      <Link
        to="/rules"
        className="text-link underline decoration-transparent underline-offset-3 hover:decoration-link"
      >
        {t('ruleDetail.back')}
      </Link>
    </nav>
  );
}

/** Rule detail: what the rule detects, whether it is on, and its source and attribution. */
function RuleDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const detail = useRule(id);
  if (detail.data === undefined) {
    if (detail.isError) {
      return (
        <section>
          <BackLink />
          <div className="mt-6">
            <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
          </div>
        </section>
      );
    }
    return <RuleDetailSkeleton />;
  }
  const { rule, source } = detail.data;
  return (
    <section>
      <PageHeader
        eyebrow={<BackLink />}
        title={rule.title}
        description={
          <span className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body">
            <SeverityBadge level={rule.level} size="lg" />
            <span className="text-muted">
              {t(`ruleTypes.${rule.type}`)}, {t(`origins.${rule.origin}`)}
            </span>
          </span>
        }
      />
      {detail.isRefetchError ? (
        <RefreshFailed error={detail.error} onRetry={() => detail.refetch()} />
      ) : null}
      <div className={COLUMNS}>
        <div className="flex min-w-0 flex-col gap-10">
          <WhatItDetects rule={rule} />
          <Section title={t('ruleDetail.source')} description={t('ruleDetail.sourceHint')}>
            <CodeBlock text={source} label={t('ruleDetail.source')} />
          </Section>
        </div>
        <div className={ASIDE}>
          <EnablePanel rule={rule} />
          <div className="border-t border-line pt-8">
            <PlaybookPanel ruleId={rule.id} origin={rule.origin} />
          </div>
          <MetadataCard rule={rule} />
        </div>
      </div>
    </section>
  );
}

function WhatItDetects({ rule }: { rule: RuleMeta }) {
  const { t } = useTranslation();
  const logsource = rule.logsource
    ? Object.entries(rule.logsource)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')
    : t('common.none');
  return (
    <Section framed title={t('ruleDetail.whatItDetects')}>
      {rule.description ? (
        <p className="max-w-prose text-lead text-fg">{rule.description}</p>
      ) : null}
      <DescriptionList
        items={[
          {
            term: t('rules.fields.logsource'),
            value: <span className="font-mono text-small">{logsource}</span>,
          },
          {
            term: t('alertDetail.attack'),
            value: <TechniqueList techniques={rule.techniques} tactics={rule.tactics} />,
          },
          {
            term: t('rules.fields.falsepositives'),
            value:
              rule.falsepositives.length === 0 ? (
                t('common.none')
              ) : (
                <ul className="flex list-disc flex-col gap-1 pl-4 marker:text-muted">
                  {rule.falsepositives.map((fp) => (
                    <li key={fp}>{fp}</li>
                  ))}
                </ul>
              ),
          },
          {
            term: t('rules.fields.references'),
            value:
              rule.references.length === 0 ? (
                t('common.none')
              ) : (
                <ul className="flex flex-col gap-1">
                  {rule.references.map((reference) => (
                    <li key={reference} className="break-all">
                      <ExternalLink href={reference}>{reference}</ExternalLink>
                    </li>
                  ))}
                </ul>
              ),
          },
        ]}
      />
    </Section>
  );
}

function EnablePanel({ rule }: { rule: RuleMeta }) {
  const { t } = useTranslation();
  const { push } = useToasts();
  const update = useUpdateRule(rule.id);
  const flight = useSingleFlight();
  const state = !rule.supported
    ? t('ruleDetail.stateUnsupported', { reason: rule.unsupportedReason ?? '' })
    : rule.buildingBlock
      ? t('ruleDetail.buildingBlock')
      : rule.enabled
        ? t('ruleDetail.stateEnabled')
        : t('ruleDetail.stateDisabled');
  return (
    <section aria-labelledby="rule-state" className="flex flex-col gap-4">
      <div>
        <h2 id="rule-state" className="text-lead font-semibold text-fg">
          {t('ruleDetail.state')}
        </h2>
        <p className="mt-0.5 text-muted">{state}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button
          variant={rule.enabled ? 'secondary' : 'primary'}
          icon={Power}
          loading={flight.busy}
          onClick={() =>
            flight.run(() =>
              update.mutateAsync(
                { enabled: !rule.enabled },
                {
                  onSuccess: (next) =>
                    push({
                      title: next.enabled
                        ? t('ruleDetail.enabledToast')
                        : t('ruleDetail.disabledToast'),
                    }),
                  onError: (error) =>
                    push({
                      tone: 'error',
                      title: t('ruleDetail.updateFailed'),
                      description: describeError(t, error).action,
                    }),
                },
              ),
            )
          }
        >
          {rule.enabled ? t('ruleDetail.disable') : t('ruleDetail.enable')}
        </Button>
        <Link
          to={`/alerts?${new URLSearchParams({ ruleId: rule.id, range: '30d' }).toString()}`}
          className="text-link underline decoration-transparent underline-offset-3 hover:decoration-link"
        >
          {t('ruleDetail.viewAlerts')}
        </Link>
      </div>
    </section>
  );
}

function MetadataCard({ rule }: { rule: RuleMeta }) {
  const { t } = useTranslation();
  const dates = [rule.date, rule.modified].filter(Boolean);
  return (
    <Section title={t('ruleDetail.metadata')} as="h2" divider>
      <DescriptionList
        items={[
          { term: t('rules.fields.author'), value: rule.author ?? t('common.none') },
          {
            term: t('rules.fields.link'),
            value: rule.url ? (
              <ExternalLink href={rule.url}>{t('rules.viewSource')}</ExternalLink>
            ) : (
              <span className="text-muted">{t('rules.noLink')}</span>
            ),
          },
          { term: t('rules.fields.license'), value: <LicenseValue license={rule.license} /> },
          { term: t('rules.table.status'), value: rule.status ?? t('common.none') },
          {
            term: t('rules.fields.date'),
            value:
              dates.length === 0
                ? t('common.none')
                : rule.modified && rule.date
                  ? t('ruleDetail.dates', { date: rule.date, modified: rule.modified })
                  : dates[0],
          },
          {
            term: t('rules.fields.id'),
            value: (
              <span className="flex items-center gap-0.5">
                <span className="break-all font-mono text-small">{rule.id}</span>
                <CopyButton value={rule.id} />
              </span>
            ),
          },
          {
            term: t('rules.fields.name'),
            value: (
              <span className="break-all font-mono text-small">
                {rule.name ?? t('common.none')}
              </span>
            ),
          },
          {
            term: t('rules.fields.path'),
            value: <span className="break-all font-mono text-small">{rule.path}</span>,
          },
        ]}
      />
    </Section>
  );
}

const COLUMNS = 'grid grid-cols-1 gap-x-12 gap-y-12 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]';
const ASIDE = 'flex min-w-0 flex-col gap-8 xl:border-l xl:border-line xl:pl-10';

/** The rule page before its first answer: real headings, placeholder values. */
function RuleDetailSkeleton() {
  const { t } = useTranslation();
  const terms = [
    t('rules.fields.logsource'),
    t('alertDetail.attack'),
    t('rules.fields.falsepositives'),
    t('rules.fields.references'),
  ];
  return (
    <LoadingRegion label={t('ruleDetail.loading')}>
      <PageHeader
        eyebrow={<BackLink />}
        title={
          <span className="block">
            <SkeletonText className="w-[min(32rem,80%)]" />
          </span>
        }
        description={
          <span className="flex items-center gap-x-5 text-body">
            <Skeleton className="h-6 w-24 rounded-badge" />
            <Skeleton className="h-5 w-40 rounded-badge" />
          </span>
        }
      />
      <div className={COLUMNS}>
        <div className="flex min-w-0 flex-col gap-10">
          <Section framed title={t('ruleDetail.whatItDetects')}>
            <SkeletonLines lines={2} className="max-w-prose text-lead" />
            <DescriptionList
              items={terms.map((term, index) => ({
                term,
                value: <SkeletonText className={index % 2 === 0 ? 'w-1/2' : 'w-2/3'} />,
              }))}
            />
          </Section>
          <Section title={t('ruleDetail.source')} description={t('ruleDetail.sourceHint')}>
            <Skeleton className="h-64 rounded-control" />
          </Section>
        </div>
        <div className={ASIDE}>
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-lead font-semibold text-fg">{t('ruleDetail.state')}</p>
              <SkeletonLines lines={1} className="mt-0.5" />
            </div>
            <Skeleton className="h-10 w-32 rounded-control" />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
