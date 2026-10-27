import { LEVELS, type Level } from '@centinela/shared';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAlertsPage, useOverviewStats } from '../api/hooks';
import { SeverityBadge } from '../components/ui/Badges';
import { PageHeader } from '../components/ui/PageHeader';
import { Section } from '../components/ui/Section';
import { LoadingRegion } from '../components/ui/Skeleton';
import { ErrorState, RefreshFailed, Updating } from '../components/ui/States';
import { TimeRangeSelect } from '../components/ui/TimeRangeSelect';
import { AttentionScoreboard, AttentionSkeleton } from '../features/overview/Attention';
import { BarList } from '../features/overview/BarList';
import { BarListSkeleton, ChartSkeleton, TrendStatSkeleton } from '../features/overview/skeletons';
import { TimeSeriesChart } from '../features/overview/TimeSeriesChart';
import { TrendStat } from '../features/overview/TrendStat';
import { useParamUpdater } from '../lib/search-params';
import {
  bucketFor,
  fillBuckets,
  previousPeriod,
  rangeQuery,
  readTimeRange,
  writeTimeRange,
  type RangePreset,
  type TimeRange,
} from '../lib/time-range';
import { useDocumentTitle } from '../lib/document-title';

/** Page size for the new alerts behind the scoreboard; more shows as "200+". */
const NEW_ALERTS_LIMIT = 200;

const SEVERITY_BAR: Readonly<Record<Level, string>> = {
  informational: 'bg-sev-informational',
  low: 'bg-sev-low',
  medium: 'bg-sev-medium',
  high: 'bg-sev-high',
  critical: 'bg-sev-critical',
};

/** Key of the range in phrases such as "in the last 24 hours". */
function rangeKey(range: TimeRange): RangePreset | 'custom' {
  return range.kind === 'preset' ? range.preset : 'custom';
}

/**
 * Overview: what needs my attention now? The scoreboard of new alerts and the ones to start
 * with come first; activity over time and where alerts come from follow.
 */
export default function OverviewPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('pages.overview.title'));
  const [params] = useSearchParams();
  const update = useParamUpdater();
  const search = params.toString();
  const range = useMemo(() => readTimeRange(new URLSearchParams(search)), [search]);
  const query = useMemo(() => ({ ...rangeQuery(range), bucket: bucketFor(range) }), [range]);
  const previousQuery = useMemo(
    () => ({ ...previousPeriod(query), bucket: query.bucket }),
    [query],
  );
  const stats = useOverviewStats(query);
  const previous = useOverviewStats(previousQuery);
  const fresh = useAlertsPage({ ...rangeQuery(range), status: ['new'], limit: NEW_ALERTS_LIMIT });

  const rangeParams = writeTimeRange(new URLSearchParams(), range);
  const withRange = (path: string, extra: Record<string, string>) => {
    const next = new URLSearchParams(rangeParams);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `${path}?${next.toString()}`;
  };
  const inRange = t(`timeRange.in.${rangeKey(range)}`);
  const previousLabel = t(`timeRange.previous.${rangeKey(range)}`);

  const header = (
    <PageHeader
      title={t('pages.overview.title')}
      description={t('pages.overview.description')}
      actions={
        <TimeRangeSelect
          value={range}
          onChange={(next) => update((current) => writeTimeRange(current, next))}
        />
      }
    />
  );

  // The first load draws the page's shape; later loads (a new range, a refresh) keep the
  // last answer on screen (S7b-17).
  if (stats.data === undefined || fresh.data === undefined) {
    const failed = stats.isError ? stats : fresh.isError ? fresh : undefined;
    return (
      <section>
        {header}
        {failed ? (
          <ErrorState error={failed.error} onRetry={() => failed.refetch()} />
        ) : (
          <OverviewSkeleton rangeLabel={inRange} />
        )}
      </section>
    );
  }
  const refreshFailed = [stats, fresh].find((query) => query.isError);

  const data = stats.data;
  const to = query.to ?? new Date().toISOString();
  const eventsSeries = fillBuckets(data.eventsOverTime, query.from, to, query.bucket);
  const alertsSeries = fillBuckets(data.alertsOverTime, query.from, to, query.bucket);

  return (
    <section>
      {header}
      {refreshFailed ? (
        <RefreshFailed error={refreshFailed.error} onRetry={() => refreshFailed.refetch()} />
      ) : null}
      <Updating
        active={stats.isPlaceholderData || fresh.isPlaceholderData}
        className="flex flex-col gap-12"
      >
        <AttentionScoreboard
          newAlerts={fresh.data.items}
          more={fresh.data.nextCursor !== null}
          acknowledged={data.alerts.byStatus.acknowledged}
          reviewHref={withRange('/alerts', { status: 'new' })}
          rangeLabel={inRange}
        />

        <Section title={t('overview.activity')} description={t('overview.activityHint')}>
          <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">
              <TrendStat
                label={t('overview.eventsOverTime')}
                value={data.events}
                previous={previous.isPlaceholderData ? undefined : previous.data?.events}
                periodLabel={previousLabel}
              />
              <TimeSeriesChart
                label={t('overview.eventsOverTime')}
                data={eventsSeries}
                bucket={query.bucket}
                kind="area"
                series="events"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <TrendStat
                label={t('overview.alertsOverTime')}
                value={data.alerts.total}
                previous={previous.isPlaceholderData ? undefined : previous.data?.alerts.total}
                periodLabel={previousLabel}
              />
              <TimeSeriesChart
                label={t('overview.alertsOverTime')}
                data={alertsSeries}
                bucket={query.bucket}
                kind="bar"
                series="alerts"
              />
            </div>
          </div>
        </Section>

        <Section title={t('overview.sources')} description={t('overview.sourcesHint')}>
          <div className={SOURCES_GRID}>
            <Ranked title={t('overview.byLevel')}>
              <BarList
                empty={t('overview.none')}
                items={[...LEVELS].reverse().map((level) => ({
                  key: level,
                  label: level,
                  count: data.alerts.byLevel[level],
                }))}
                barClass={(key) => SEVERITY_BAR[LEVELS.find((level) => level === key) ?? 'low']}
                renderLabel={(item) => (
                  <Link
                    to={withRange('/alerts', { level: item.key })}
                    className="rounded-badge hover:underline hover:decoration-line-strong hover:underline-offset-3"
                  >
                    <SeverityBadge
                      level={LEVELS.find((level) => level === item.key) ?? 'informational'}
                    />
                  </Link>
                )}
              />
            </Ranked>
            <Ranked title={t('overview.topIps')}>
              <BarList
                empty={t('overview.none')}
                items={data.topSourceIps.map((row) => ({
                  key: row.ip,
                  label: row.ip,
                  count: row.count,
                }))}
                renderLabel={(item) => (
                  <Link to={withRange('/events', { ip: item.key })} className={linkClass}>
                    {item.key}
                  </Link>
                )}
              />
            </Ranked>
            <Ranked title={t('overview.topUsers')}>
              <BarList
                empty={t('overview.none')}
                items={data.topUsers.map((row) => ({
                  key: row.user,
                  label: row.user,
                  count: row.count,
                }))}
                renderLabel={(item) => (
                  <Link to={withRange('/events', { user: item.key })} className={linkClass}>
                    {item.key}
                  </Link>
                )}
              />
            </Ranked>
            <Ranked title={t('overview.topRules')}>
              <BarList
                empty={t('overview.none')}
                items={data.topRules.map((row) => ({
                  key: row.ruleId,
                  label: row.title,
                  count: row.count,
                }))}
                renderLabel={(item) => (
                  <Link to={`/rules/${item.key}`} className={linkClass}>
                    {item.label}
                  </Link>
                )}
              />
            </Ranked>
          </div>
        </Section>
      </Updating>
    </section>
  );
}

const SOURCES_GRID =
  'grid grid-cols-1 gap-y-10 md:grid-cols-2 md:gap-x-10 xl:grid-cols-4 xl:gap-x-0 xl:divide-x xl:divide-line';

const linkClass =
  'text-link underline decoration-transparent underline-offset-3 hover:decoration-link';

function Ranked({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 xl:px-6 xl:first:pl-0 xl:last:pr-0">
      <h3 className="mb-3 font-semibold text-fg">{title}</h3>
      {children}
    </div>
  );
}

/**
 * The Overview before its first answer: the same sections, headings and labels, with
 * placeholders where the numbers, charts and lists go, so nothing moves when they arrive.
 */
function OverviewSkeleton({ rangeLabel }: { rangeLabel: string }) {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('overview.loading')} className="flex flex-col gap-12">
      <AttentionSkeleton rangeLabel={rangeLabel} />
      <Section title={t('overview.activity')} description={t('overview.activityHint')}>
        <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <TrendStatSkeleton label={t('overview.eventsOverTime')} />
            <ChartSkeleton kind="area" />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <TrendStatSkeleton label={t('overview.alertsOverTime')} />
            <ChartSkeleton kind="bar" />
          </div>
        </div>
      </Section>
      <Section title={t('overview.sources')} description={t('overview.sourcesHint')}>
        <div className={SOURCES_GRID}>
          <Ranked title={t('overview.byLevel')}>
            <BarListSkeleton rows={LEVELS.length} />
          </Ranked>
          <Ranked title={t('overview.topIps')}>
            <BarListSkeleton />
          </Ranked>
          <Ranked title={t('overview.topUsers')}>
            <BarListSkeleton />
          </Ranked>
          <Ranked title={t('overview.topRules')}>
            <BarListSkeleton />
          </Ranked>
        </div>
      </Section>
    </LoadingRegion>
  );
}
