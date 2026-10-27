import type { Alert } from '@centinela/shared';
import { CheckCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { flattenPages, useAlertsList, useBulkUpdateAlerts } from '../api/hooks';
import { SeverityBadge, StatusBadge } from '../components/ui/Badges';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Fields';
import { Truncate } from '../components/ui/Truncate';
import { DataTable, TableSkeleton, type Column } from '../components/ui/DataTable';
import { LoadMore } from '../components/ui/LoadMore';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton, SkeletonText } from '../components/ui/Skeleton';
import { lineWidth } from '../components/ui/skeleton-widths';
import { EmptyState, ErrorState, RefreshFailed, Updating } from '../components/ui/States';
import { useToasts } from '../components/ui/toast-context';
import { AlertFilterBar } from '../features/alerts/AlertFilterBar';
import {
  ALERT_TEXT_FILTERS,
  alertQueryParams,
  readAlertFilters,
} from '../features/alerts/alert-filters';
import { EntitySummary } from '../features/alerts/EntityList';
import { useFreshAlerts } from '../features/live/live-context';
import { describeError } from '../lib/error-text';
import { useFormat } from '../lib/format';
import { useSingleFlight } from '../lib/single-flight';

export default function AlertsPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const { push } = useToasts();
  const [params] = useSearchParams();
  const search = params.toString();
  const filters = useMemo(() => readAlertFilters(new URLSearchParams(search)), [search]);
  const query = useMemo(() => alertQueryParams(filters), [filters]);
  const list = useAlertsList(query);
  const bulk = useBulkUpdateAlerts();
  const flight = useSingleFlight();
  const fresh = useFreshAlerts();
  const alerts = flattenPages(list.data);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selectionKey, setSelectionKey] = useState(search);

  // A new filter is a new list: drop the selection (adjusting state during render).
  if (selectionKey !== search) {
    setSelectionKey(search);
    setSelected(new Set());
  }

  const visibleSelected = alerts.filter((alert) => selected.has(alert.id));
  const allSelected = alerts.length > 0 && visibleSelected.length === alerts.length;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function acknowledgeSelected() {
    const ids = visibleSelected.filter((alert) => alert.status === 'new').map((alert) => alert.id);
    if (ids.length === 0) return;
    // The rows show "Acknowledged" at once; a refusal puts them back and says so.
    flight.run(() =>
      bulk.mutateAsync(
        { ids, status: 'acknowledged' },
        {
          onSuccess: ({ updated }) => {
            setSelected(new Set());
            push({ title: t('alerts.bulk.done', { value: format.number(updated) }) });
          },
          onError: (error) =>
            push({
              tone: 'error',
              title: t('alerts.bulk.failed'),
              description: t('alerts.bulk.rolledBack', {
                action: describeError(t, error).action,
              }),
            }),
        },
      ),
    );
  }

  const columns: Array<Column<Alert>> = [
    {
      id: 'select',
      header: (
        <Checkbox
          aria-label={t('alerts.table.selectAll')}
          checked={allSelected}
          indeterminate={!allSelected && visibleSelected.length > 0}
          onChange={() => setSelected(allSelected ? new Set() : new Set(alerts.map((a) => a.id)))}
        />
      ),
      cell: (alert) => (
        <Checkbox
          aria-label={t('alerts.table.select', { title: alert.ruleTitle })}
          checked={selected.has(alert.id)}
          onChange={() => toggle(alert.id)}
        />
      ),
      className: 'w-10 pr-0',
      skeleton: () => (
        <span className="flex h-[1lh] items-center">
          <Skeleton className="size-[18px] rounded-badge" />
        </span>
      ),
    },
    {
      id: 'level',
      header: t('alerts.table.level'),
      cell: (alert) => <SeverityBadge level={alert.level} />,
      className: 'w-32',
      skeleton: () => <SkeletonText className="w-20" />,
    },
    {
      id: 'title',
      header: t('alerts.table.title'),
      cell: (alert) => (
        <span className="flex flex-col items-start gap-1">
          <Link
            to={`/alerts/${alert.id}`}
            className="font-semibold text-fg underline decoration-transparent underline-offset-3 hover:decoration-line-strong"
            tabIndex={-1}
          >
            {alert.ruleTitle}
          </Link>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 @3xl:hidden">
            <span className="@xl:hidden">
              <StatusBadge status={alert.status} />
            </span>
            <time dateTime={alert.lastSeen} className="text-small text-muted">
              {format.relative(alert.lastSeen)}
            </time>
          </span>
        </span>
      ),
      // Title, then (on narrow tables) the status and time line under it.
      skeleton: (index) => (
        <span className="flex flex-col gap-1">
          <SkeletonText className={lineWidth(index)} />
          <span className="@3xl:hidden">
            <SkeletonText className="w-28" />
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: t('alerts.table.status'),
      cell: (alert) => <StatusBadge status={alert.status} />,
      className: 'hidden @xl:table-cell w-36',
    },
    {
      id: 'host',
      header: t('alerts.table.host'),
      cell: (alert) => <Truncate text={alert.host ?? t('common.none')} className="max-w-[9rem]" />,
      className: 'hidden @2xl:table-cell w-36',
    },
    {
      id: 'entities',
      header: t('alerts.table.entities'),
      cell: (alert) => <EntitySummary entities={alert.entities} />,
      className: 'hidden @5xl:table-cell w-60',
    },
    {
      id: 'count',
      header: t('alerts.table.count'),
      cell: (alert) => format.number(alert.count),
      className: 'hidden @4xl:table-cell w-20 text-right',
    },
    {
      id: 'lastSeen',
      header: t('alerts.table.lastSeen'),
      cell: (alert) => (
        <time
          dateTime={alert.lastSeen}
          title={format.dateTime(alert.lastSeen)}
          className="whitespace-nowrap text-muted"
        >
          {format.shortDateTime(alert.lastSeen)}
        </time>
      ),
      className: 'hidden @3xl:table-cell w-36 text-right',
    },
  ];

  const newSelected = visibleSelected.filter((alert) => alert.status === 'new').length;

  return (
    <section>
      <PageHeader title={t('pages.alerts.title')} description={t('pages.alerts.description')} />
      <AlertFilterBar
        key={ALERT_TEXT_FILTERS.map((key) => filters.text[key] ?? '').join('|')}
        filters={filters}
      />
      <div className="mb-2 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          variant="primary"
          icon={CheckCheck}
          loading={flight.busy}
          disabled={newSelected === 0}
          onClick={acknowledgeSelected}
        >
          {t('alerts.bulk.acknowledge')}
        </Button>
        <span className="text-muted" aria-live="polite">
          {/* The rows already show the new status; this says it is still being saved. */}
          {flight.busy
            ? t('alerts.bulk.saving')
            : visibleSelected.length > 0 && newSelected === 0
              ? t('alerts.bulk.nothingNew', { value: format.number(visibleSelected.length) })
              : t('alerts.bulk.selected', { value: format.number(visibleSelected.length) })}
        </span>
      </div>
      {list.data === undefined ? (
        list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <TableSkeleton columns={columns} label={t('alerts.loading')} />
        )
      ) : (
        <>
          {list.isRefetchError ? (
            <RefreshFailed error={list.error} onRetry={() => list.refetch()} />
          ) : null}
          <Updating active={list.isPlaceholderData}>
            {alerts.length === 0 ? (
              <EmptyState
                title={t('alerts.empty.title')}
                description={t('alerts.empty.description')}
              />
            ) : (
              <>
                <DataTable
                  caption={t('alerts.table.caption')}
                  columns={columns}
                  rows={alerts}
                  getRowId={(alert) => alert.id}
                  rowLabel={(alert) => `${t(`levels.${alert.level}`)}: ${alert.ruleTitle}`}
                  isRowSelected={(alert) => selected.has(alert.id)}
                  isRowFresh={(alert) => fresh.has(alert.id)}
                  onOpen={(alert) => void navigate(`/alerts/${alert.id}`)}
                />
                <LoadMore
                  shown={alerts.length}
                  hasMore={list.hasNextPage}
                  loading={list.isFetchingNextPage}
                  failed={list.isFetchNextPageError}
                  onLoadMore={() => void list.fetchNextPage({ cancelRefetch: false })}
                />
              </>
            )}
          </Updating>
        </>
      )}
    </section>
  );
}
