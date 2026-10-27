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
import { DataTable, type Column } from '../components/ui/DataTable';
import { LoadMore } from '../components/ui/LoadMore';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useToasts } from '../components/ui/toast-context';
import { AlertFilterBar } from '../features/alerts/AlertFilterBar';
import {
  ALERT_TEXT_FILTERS,
  alertQueryParams,
  readAlertFilters,
} from '../features/alerts/alert-filters';
import { EntitySummary } from '../features/alerts/EntityList';
import { useFormat } from '../lib/format';

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
    bulk.mutate(
      { ids, status: 'acknowledged' },
      {
        onSuccess: ({ updated }) => {
          setSelected(new Set());
          push({ title: t('alerts.bulk.done', { value: format.number(updated) }) });
        },
        onError: () => push({ title: t('alerts.bulk.failed') }),
      },
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
    },
    {
      id: 'level',
      header: t('alerts.table.level'),
      cell: (alert) => <SeverityBadge level={alert.level} />,
      className: 'w-32',
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
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 md:hidden">
            <span className="sm:hidden">
              <StatusBadge status={alert.status} />
            </span>
            <time dateTime={alert.lastSeen} className="text-small text-muted">
              {format.relative(alert.lastSeen)}
            </time>
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: t('alerts.table.status'),
      cell: (alert) => <StatusBadge status={alert.status} />,
      className: 'hidden sm:table-cell w-36',
    },
    {
      id: 'host',
      header: t('alerts.table.host'),
      cell: (alert) => <Truncate text={alert.host ?? t('common.none')} className="max-w-[9rem]" />,
      className: 'hidden md:table-cell w-36',
    },
    {
      id: 'entities',
      header: t('alerts.table.entities'),
      cell: (alert) => <EntitySummary entities={alert.entities} />,
      className: 'hidden lg:table-cell w-60',
    },
    {
      id: 'count',
      header: t('alerts.table.count'),
      cell: (alert) => format.number(alert.count),
      className: 'hidden sm:table-cell w-20 text-right',
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
      className: 'hidden md:table-cell w-36 text-right',
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
          loading={bulk.isPending}
          disabled={newSelected === 0}
          onClick={acknowledgeSelected}
        >
          {t('alerts.bulk.acknowledge')}
        </Button>
        <span className="text-muted" aria-live="polite">
          {visibleSelected.length > 0 && newSelected === 0
            ? t('alerts.bulk.nothingNew', { value: format.number(visibleSelected.length) })
            : t('alerts.bulk.selected', { value: format.number(visibleSelected.length) })}
        </span>
      </div>
      {list.isPending ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : alerts.length === 0 ? (
        <EmptyState title={t('alerts.empty.title')} description={t('alerts.empty.description')} />
      ) : (
        <>
          <DataTable
            caption={t('alerts.table.caption')}
            columns={columns}
            rows={alerts}
            getRowId={(alert) => alert.id}
            rowLabel={(alert) => `${t(`levels.${alert.level}`)}: ${alert.ruleTitle}`}
            isRowSelected={(alert) => selected.has(alert.id)}
            onOpen={(alert) => void navigate(`/alerts/${alert.id}`)}
          />
          <LoadMore
            shown={alerts.length}
            hasMore={list.hasNextPage}
            loading={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
          />
        </>
      )}
    </section>
  );
}
