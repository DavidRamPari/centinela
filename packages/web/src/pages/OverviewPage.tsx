import { LEVELS } from '@centinela/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAlertsPage, useOverviewStats } from '../api/hooks';
import { SeverityBadge, StatusBadge } from '../components/ui/Badges';
import { Card, KpiCard } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { ErrorState, LoadingState } from '../components/ui/States';
import { TimeRangeSelect } from '../components/ui/TimeRangeSelect';
import { BarList } from '../features/overview/BarList';
import { TimeSeriesChart } from '../features/overview/TimeSeriesChart';
import { useFormat } from '../lib/format';
import { useParamUpdater } from '../lib/search-params';
import {
  bucketFor,
  fillBuckets,
  rangeQuery,
  readTimeRange,
  writeTimeRange,
} from '../lib/time-range';

export default function OverviewPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const [params] = useSearchParams();
  const update = useParamUpdater();
  const search = params.toString();
  const range = useMemo(() => readTimeRange(new URLSearchParams(search)), [search]);
  const query = useMemo(() => ({ ...rangeQuery(range), bucket: bucketFor(range) }), [range]);
  const stats = useOverviewStats(query);
  const latest = useAlertsPage({ ...rangeQuery(range), limit: 6 });

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

  if (stats.isPending)
    return (
      <section>
        {header}
        <LoadingState />
      </section>
    );
  if (stats.isError) {
    return (
      <section>
        {header}
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
      </section>
    );
  }

  const data = stats.data;
  const to = query.to ?? new Date().toISOString();
  const eventsSeries = fillBuckets(data.eventsOverTime, query.from, to, query.bucket);
  const alertsSeries = fillBuckets(data.alertsOverTime, query.from, to, query.bucket);
  const open = data.alerts.byStatus.new + data.alerts.byStatus.acknowledged;
  const severe = data.alerts.byLevel.high + data.alerts.byLevel.critical;
  const rangeParams = writeTimeRange(new URLSearchParams(), range);
  const withRange = (path: string, extra: Record<string, string>) => {
    const next = new URLSearchParams(rangeParams);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `${path}?${next.toString()}`;
  };

  return (
    <section>
      {header}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label={t('overview.kpi.events')} value={format.number(data.events)} />
        <KpiCard label={t('overview.kpi.alerts')} value={format.number(data.alerts.total)} />
        <KpiCard
          label={t('overview.kpi.open')}
          value={format.number(open)}
          hint={t('overview.kpi.openHint', { value: format.number(data.alerts.byStatus.new) })}
        />
        <KpiCard
          label={t('overview.kpi.severe')}
          value={format.number(severe)}
          hint={t('overview.kpi.severeHint')}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={t('overview.eventsOverTime')}>
          <TimeSeriesChart
            label={t('overview.eventsOverTime')}
            data={eventsSeries}
            bucket={query.bucket}
            kind="area"
          />
        </Card>
        <Card title={t('overview.alertsOverTime')}>
          <TimeSeriesChart
            label={t('overview.alertsOverTime')}
            data={alertsSeries}
            bucket={query.bucket}
            kind="bar"
          />
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title={t('overview.byLevel')}>
          <BarList
            empty={t('overview.none')}
            items={[...LEVELS]
              .reverse()
              .map((level) => ({ key: level, label: level, count: data.alerts.byLevel[level] }))}
            renderLabel={(item) => (
              <Link to={withRange('/alerts', { level: item.key })} className="hover:underline">
                <SeverityBadge
                  level={LEVELS.find((level) => level === item.key) ?? 'informational'}
                />
              </Link>
            )}
          />
        </Card>
        <Card title={t('overview.topIps')}>
          <BarList
            empty={t('overview.none')}
            items={data.topSourceIps.map((row) => ({
              key: row.ip,
              label: row.ip,
              count: row.count,
            }))}
            renderLabel={(item) => (
              <Link
                to={withRange('/events', { ip: item.key })}
                className="font-mono text-xs text-accent hover:underline"
              >
                {item.key}
              </Link>
            )}
          />
        </Card>
        <Card title={t('overview.topUsers')}>
          <BarList
            empty={t('overview.none')}
            items={data.topUsers.map((row) => ({
              key: row.user,
              label: row.user,
              count: row.count,
            }))}
            renderLabel={(item) => (
              <Link
                to={withRange('/events', { user: item.key })}
                className="font-mono text-xs text-accent hover:underline"
              >
                {item.key}
              </Link>
            )}
          />
        </Card>
        <Card title={t('overview.topRules')}>
          <BarList
            empty={t('overview.none')}
            items={data.topRules.map((row) => ({
              key: row.ruleId,
              label: row.title,
              count: row.count,
            }))}
            renderLabel={(item) => (
              <Link to={`/rules/${item.key}`} className="text-accent hover:underline">
                {item.label}
              </Link>
            )}
          />
        </Card>
      </div>

      <Card
        className="mt-4"
        title={t('overview.latest')}
        actions={
          <Link to={withRange('/alerts', {})} className="text-accent hover:underline">
            {t('overview.allAlerts')}
          </Link>
        }
      >
        {latest.isPending ? (
          <LoadingState />
        ) : latest.isError ? (
          <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />
        ) : latest.data.items.length === 0 ? (
          <p className="text-muted">{t('overview.none')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {latest.data.items.map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <SeverityBadge level={alert.level} />
                <Link
                  to={`/alerts/${alert.id}`}
                  className="min-w-0 flex-1 font-medium text-fg hover:text-accent hover:underline"
                >
                  {alert.ruleTitle}
                </Link>
                <StatusBadge status={alert.status} />
                <span className="font-mono text-xs text-muted">{alert.host ?? '—'}</span>
                <time dateTime={alert.lastSeen} className="text-xs text-muted">
                  {format.shortDateTime(alert.lastSeen)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
