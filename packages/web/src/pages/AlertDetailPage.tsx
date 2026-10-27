import type { Alert, NormalizedEvent, RuleMeta } from '@centinela/shared';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { useAlert } from '../api/hooks';
import { SeverityBadge, StatusBadge } from '../components/ui/Badges';
import { CopyButton } from '../components/ui/CopyButton';
import { DescriptionList } from '../components/ui/DescriptionList';
import { PageHeader } from '../components/ui/PageHeader';
import { Section } from '../components/ui/Section';
import { LoadingRegion, Skeleton, SkeletonLines, SkeletonText } from '../components/ui/Skeleton';
import { EmptyState, ErrorState, RefreshFailed } from '../components/ui/States';
import { userDomains } from '../features/alerts/entities';
import { RulePanel } from '../features/alerts/RulePanel';
import { Timeline } from '../features/alerts/timeline/Timeline';
import { TriagePanel } from '../features/alerts/TriagePanel';
import { PlaybookPanel } from '../features/alerts/playbook/PlaybookPanel';
import { TechniqueList } from '../features/attack/TechniqueLink';
import { useFormat } from '../lib/format';

const idSchema = z.uuid();

/** Same calendar day in the browser's time zone. */
function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export default function AlertDetailPage() {
  const { t } = useTranslation();
  const params = useParams();
  const id = idSchema.safeParse(params.id);
  if (!id.success) {
    return (
      <section>
        <Breadcrumb />
        <EmptyState title={t('alertDetail.notFound')} />
      </section>
    );
  }
  return <AlertDetail id={id.data} />;
}

function Breadcrumb() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('common.breadcrumb')}>
      <Link
        to="/alerts"
        className="text-link underline decoration-transparent underline-offset-3 hover:decoration-link"
      >
        {t('alertDetail.back')}
      </Link>
    </nav>
  );
}

/**
 * Alert detail: what happened, to which host and user, and what to do next. The facts
 * come first in the page's framed area, the playbook and triage beside them; internals
 * (keys, ids) wait in a collapsed "Technical details" (docs/decisions/S7b.md).
 */
function AlertDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const detail = useAlert(id);

  if (detail.data === undefined) {
    if (detail.isError) {
      return (
        <section>
          <Breadcrumb />
          <div className="mt-6">
            <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
          </div>
        </section>
      );
    }
    return <AlertDetailSkeleton />;
  }
  const { alert, rule, events } = detail.data;

  return (
    <section>
      <PageHeader
        eyebrow={<Breadcrumb />}
        title={alert.ruleTitle}
        description={
          <span className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body">
            <SeverityBadge level={alert.level} size="lg" />
            <StatusBadge status={alert.status} />
            <span className="text-muted">{t(`ruleTypes.${alert.ruleType}`)}</span>
          </span>
        }
      />
      {detail.isRefetchError ? (
        <RefreshFailed error={detail.error} onRetry={() => detail.refetch()} />
      ) : null}
      <div className={COLUMNS}>
        <div className="flex min-w-0 flex-col gap-10">
          <WhatHappened alert={alert} rule={rule} events={events} />
          <Section
            title={t('alertDetail.timeline.title')}
            description={t('alertDetail.timeline.count', { count: events.length })}
          >
            <Timeline events={events} />
          </Section>
          <RulePanel alert={alert} rule={rule} />
          <TechnicalDetails alert={alert} />
        </div>
        <aside aria-labelledby="next-title" className={ASIDE}>
          <h2 id="next-title" className="-mb-4 text-small font-semibold text-muted">
            {t('alertDetail.next')}
          </h2>
          <TriagePanel key={alert.id} alert={alert} />
          <div className="border-t border-line pt-8">
            <PlaybookPanel ruleId={alert.ruleId} origin={rule?.origin} />
          </div>
        </aside>
      </div>
    </section>
  );
}

function EntityLinks({
  param,
  values,
  display,
}: {
  param: 'ip' | 'user' | 'host';
  values: readonly string[];
  display?: (value: string) => string;
}) {
  const { t } = useTranslation();
  if (values.length === 0) return <span className="text-muted">{t('common.none')}</span>;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {values.map((value) => (
        <li key={value} className="flex min-w-0 items-center gap-0.5">
          <Link
            to={`/events?${new URLSearchParams({ [param]: value, range: '7d' }).toString()}`}
            className="break-all text-link underline decoration-transparent underline-offset-3 hover:decoration-link"
            title={t('alertDetail.entities.searchEvents')}
          >
            {display?.(value) ?? value}
          </Link>
          <CopyButton value={display?.(value) ?? value} />
        </li>
      ))}
    </ul>
  );
}

function WhatHappened({
  alert,
  rule,
  events,
}: {
  alert: Alert;
  rule: RuleMeta | null;
  events: NormalizedEvent[];
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const domains = userDomains(events);
  const hosts = [...new Set([alert.host, ...alert.entities.hosts].filter((h) => h !== null))];
  const span = Date.parse(alert.lastSeen) - Date.parse(alert.firstSeen);
  const items: Array<{ term: string; value: ReactNode }> = [
    { term: t('alertDetail.hosts'), value: <EntityLinks param="host" values={hosts} /> },
    {
      term: t('alertDetail.entities.users'),
      value: (
        <EntityLinks
          param="user"
          values={alert.entities.users}
          display={(user) => domains.get(user) ?? user}
        />
      ),
    },
    {
      term: t('alertDetail.entities.ips'),
      value: <EntityLinks param="ip" values={alert.entities.ips} />,
    },
    {
      term: t('alertDetail.when'),
      value:
        span > 0 ? (
          <span>
            {t('alertDetail.whenRange', {
              from: format.dateTime(alert.firstSeen),
              to: sameDay(alert.firstSeen, alert.lastSeen)
                ? format.timeWithSeconds(alert.lastSeen)
                : format.dateTime(alert.lastSeen),
            })}{' '}
            <span className="text-muted">({format.span(span)})</span>
          </span>
        ) : (
          <time dateTime={alert.firstSeen}>{format.dateTime(alert.firstSeen)}</time>
        ),
    },
    {
      term: t('alertDetail.matches'),
      value: t('alertDetail.matchesValue', {
        count: alert.count,
        value: format.number(alert.count),
      }),
    },
    {
      term: t('alertDetail.attack'),
      value: <TechniqueList techniques={alert.techniques} tactics={alert.tactics} />,
    },
  ];
  return (
    <Section framed title={t('alertDetail.whatHappened')}>
      {rule?.description ? (
        <p className="max-w-prose text-lead text-fg">{rule.description}</p>
      ) : null}
      <DescriptionList items={items} />
    </Section>
  );
}

function TechnicalDetails({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const format = useFormat();
  const mono = (value: string | null) =>
    value ? (
      <span className="flex items-center gap-0.5">
        <span className="font-mono text-small break-all">{value}</span>
        <CopyButton value={value} />
      </span>
    ) : (
      t('common.none')
    );
  return (
    <details className="group border-t border-line pt-6">
      <summary className="-mx-1.5 flex h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-control px-1.5 font-semibold text-fg transition-colors duration-100 hover:bg-hover active:bg-pressed [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          strokeWidth={2}
          className="size-4 transition-transform duration-100 group-open:rotate-90"
        />
        {t('alertDetail.technical')}
      </summary>
      <div className="mt-4 pl-6">
        <DescriptionList
          items={[
            { term: t('alertDetail.alertId'), value: mono(alert.id) },
            { term: t('alertDetail.ruleId'), value: mono(alert.ruleId) },
            { term: t('alertDetail.groupKey'), value: mono(alert.groupKey) },
            { term: t('alertDetail.dedupKey'), value: mono(alert.dedupKey) },
            {
              term: t('alertDetail.firstSeen'),
              value: <time dateTime={alert.firstSeen}>{format.dateTime(alert.firstSeen)}</time>,
            },
            {
              term: t('alertDetail.lastSeen'),
              value: <time dateTime={alert.lastSeen}>{format.dateTime(alert.lastSeen)}</time>,
            },
            {
              term: t('alertDetail.resolution'),
              value: alert.resolution ? t(`resolutions.${alert.resolution}`) : t('common.none'),
            },
            { term: t('alertDetail.note'), value: alert.note ?? t('common.none') },
            {
              term: t('alertDetail.createdAt'),
              value: <time dateTime={alert.createdAt}>{format.dateTime(alert.createdAt)}</time>,
            },
            {
              term: t('alertDetail.updatedAt'),
              value: <time dateTime={alert.updatedAt}>{format.dateTime(alert.updatedAt)}</time>,
            },
          ]}
        />
      </div>
    </details>
  );
}

const COLUMNS = 'grid grid-cols-1 gap-x-12 gap-y-12 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]';
const ASIDE = 'flex min-w-0 flex-col gap-8 xl:border-l xl:border-line xl:pl-10';

/**
 * The alert page before its first answer: the same header, columns and section headings,
 * with placeholders for the title, the facts, the timeline and the triage controls.
 */
function AlertDetailSkeleton() {
  const { t } = useTranslation();
  const terms = [
    t('alertDetail.hosts'),
    t('alertDetail.entities.users'),
    t('alertDetail.entities.ips'),
    t('alertDetail.when'),
    t('alertDetail.matches'),
    t('alertDetail.attack'),
  ];
  return (
    <LoadingRegion label={t('alertDetail.loading')}>
      <PageHeader
        eyebrow={<Breadcrumb />}
        title={
          <span className="block">
            <SkeletonText className="w-[min(32rem,80%)]" />
          </span>
        }
        description={
          <span className="flex items-center gap-x-5 text-body">
            <Skeleton className="h-6 w-24 rounded-badge" />
            <Skeleton className="h-6 w-28 rounded-badge" />
          </span>
        }
      />
      <div className={COLUMNS}>
        <div className="flex min-w-0 flex-col gap-10">
          <Section framed title={t('alertDetail.whatHappened')}>
            <SkeletonLines lines={2} className="max-w-prose text-lead" />
            <DescriptionList
              items={terms.map((term, index) => ({
                term,
                value: <SkeletonText className={index % 2 === 0 ? 'w-1/2' : 'w-1/3'} />,
              }))}
            />
          </Section>
          <Section title={t('alertDetail.timeline.title')}>
            <ul aria-hidden="true" className="flex flex-col">
              {[0, 1, 2, 3].map((index) => (
                <li
                  key={index}
                  className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 border-b border-line py-3 last:border-b-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]"
                >
                  <SkeletonText className="w-16" />
                  <span className="flex flex-col gap-1.5">
                    <SkeletonText className={index % 2 === 0 ? 'w-3/4' : 'w-2/3'} />
                    <span className="text-small">
                      <SkeletonText className="w-full" />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
        <aside className={ASIDE}>
          <p className="-mb-4 text-small font-semibold text-muted">{t('alertDetail.next')}</p>
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-lead font-semibold text-fg">{t('triage.title')}</p>
              <SkeletonLines lines={2} className="mt-0.5" />
            </div>
            <Skeleton className="h-[4.75rem] w-full rounded-control" />
            <Skeleton className="h-10 w-36 rounded-control" />
          </div>
        </aside>
      </div>
    </LoadingRegion>
  );
}
