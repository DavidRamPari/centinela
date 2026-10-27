import type { Alert, NormalizedEvent } from '@centinela/shared';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { useAlert } from '../api/hooks';
import { SeverityBadge, StatusBadge } from '../components/ui/Badges';
import { Card } from '../components/ui/Card';
import { DescriptionList } from '../components/ui/DescriptionList';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { RulePanel } from '../features/alerts/RulePanel';
import { TriagePanel } from '../features/alerts/TriagePanel';
import { PlaybookPanel } from '../features/alerts/playbook/PlaybookPanel';
import { TacticNames, TechniqueLink } from '../features/attack/TechniqueLink';
import { OutcomeLabel } from '../features/events/OutcomeLabel';
import { useFormat } from '../lib/format';

const idSchema = z.uuid();

export default function AlertDetailPage() {
  const { t } = useTranslation();
  const params = useParams();
  const id = idSchema.safeParse(params.id);
  if (!id.success) {
    return (
      <section>
        <BackLink />
        <EmptyState title={t('alertDetail.notFound')} />
      </section>
    );
  }
  return <AlertDetail id={id.data} />;
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link to="/alerts" className="mb-3 inline-flex items-center gap-1 text-accent hover:underline">
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t('alertDetail.back')}
    </Link>
  );
}

function AlertDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const detail = useAlert(id);

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) {
    return (
      <section>
        <BackLink />
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </section>
    );
  }
  const { alert, rule, events } = detail.data;

  return (
    <section>
      <BackLink />
      <PageHeader
        title={alert.ruleTitle}
        description={t('alertDetail.subtitle', { id: alert.id })}
        actions={
          <div className="flex items-center gap-2">
            <SeverityBadge level={alert.level} />
            <StatusBadge status={alert.status} />
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <SummaryCard alert={alert} />
          <PlaybookPanel ruleId={alert.ruleId} />
          <EntitiesCard alert={alert} />
          <TimelineCard events={events} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <TriagePanel key={`${alert.status}|${alert.updatedAt}`} alert={alert} />
          <TechniquesCard alert={alert} />
          <RulePanel alert={alert} rule={rule} />
        </div>
      </div>
    </section>
  );
}

function SummaryCard({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card title={t('alertDetail.summary')}>
      <DescriptionList
        items={[
          { term: t('alerts.table.level'), value: <SeverityBadge level={alert.level} /> },
          { term: t('alerts.table.status'), value: <StatusBadge status={alert.status} /> },
          {
            term: t('alertDetail.resolution'),
            value: alert.resolution ? t(`resolutions.${alert.resolution}`) : '—',
          },
          {
            term: t('alertDetail.firstSeen'),
            value: <time dateTime={alert.firstSeen}>{format.dateTime(alert.firstSeen)}</time>,
          },
          {
            term: t('alertDetail.lastSeen'),
            value: <time dateTime={alert.lastSeen}>{format.dateTime(alert.lastSeen)}</time>,
          },
          { term: t('alerts.table.count'), value: format.number(alert.count) },
          {
            term: t('alerts.table.host'),
            value: <span className="font-mono">{alert.host ?? '—'}</span>,
          },
          {
            term: t('alertDetail.groupKey'),
            value: <span className="font-mono text-xs">{alert.groupKey ?? '—'}</span>,
          },
          {
            term: t('alertDetail.dedupKey'),
            value: <span className="break-all font-mono text-xs">{alert.dedupKey}</span>,
          },
          { term: t('alertDetail.note'), value: alert.note ?? '—' },
          {
            term: t('alertDetail.updatedAt'),
            value: <time dateTime={alert.updatedAt}>{format.dateTime(alert.updatedAt)}</time>,
          },
        ]}
      />
    </Card>
  );
}

function EntitiesCard({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const groups = [
    { key: 'ips', param: 'ip', values: alert.entities.ips },
    { key: 'users', param: 'user', values: alert.entities.users },
    { key: 'hosts', param: 'host', values: alert.entities.hosts },
  ] as const;
  return (
    <Card title={t('alertDetail.entities.title')}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {groups.map((group) => (
          <div key={group.key} className="min-w-0">
            <h3 className="text-xs font-medium text-muted">
              {t(`alertDetail.entities.${group.key}`)}
            </h3>
            {group.values.length === 0 ? (
              <p className="text-muted">—</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {group.values.map((value) => (
                  <li key={value} className="min-w-0">
                    <Link
                      to={`/events?${new URLSearchParams({ [group.param]: value, range: '7d' }).toString()}`}
                      className="break-all font-mono text-xs text-accent hover:underline"
                      title={t('alertDetail.entities.searchEvents')}
                    >
                      {value}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function TechniquesCard({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  return (
    <Card title={t('alertDetail.attack')}>
      {alert.techniques.length === 0 ? (
        <p className="text-muted">{t('alertDetail.noTechniques')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            {alert.techniques.map((technique) => (
              <li key={technique}>
                <TechniqueLink id={technique} />
              </li>
            ))}
          </ul>
          <p className="text-xs">
            <span className="text-muted">{t('alertDetail.tactics')}: </span>
            <TacticNames tactics={alert.tactics} />
          </p>
        </div>
      )}
    </Card>
  );
}

function TimelineCard({ events }: { events: NormalizedEvent[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card title={t('alertDetail.timeline.title')}>
      {events.length === 0 ? (
        <p className="text-muted">{t('alertDetail.timeline.empty')}</p>
      ) : (
        <ol className="flex flex-col border-l border-line">
          {events.map((event) => (
            <li key={event.id} className="relative ml-3 border-b border-line py-2 last:border-b-0">
              <span
                aria-hidden="true"
                className="absolute -left-[1.03rem] top-3.5 size-2 rounded-full bg-accent"
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <time dateTime={event.ts} className="text-muted">
                  {format.dateTime(event.ts)}
                </time>
                <span className="font-mono">{event.action}</span>
                <OutcomeLabel outcome={event.outcome} />
                {event.srcIp ? <span className="font-mono">{event.srcIp}</span> : null}
                <Link to={`/events?event=${event.id}`} className="text-accent hover:underline">
                  {t('alertDetail.timeline.open')}
                </Link>
              </div>
              <p className="mt-1 line-clamp-2 break-all font-mono text-xs text-fg">
                {event.message}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
