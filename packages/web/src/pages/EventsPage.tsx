import type { NormalizedEvent } from '@centinela/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { z } from 'zod';
import { flattenPages, useEventsList } from '../api/hooks';
import { DataTable, type Column } from '../components/ui/DataTable';
import { LoadMore } from '../components/ui/LoadMore';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { EventDrawer } from '../features/events/EventDrawer';
import { EventFilterBar } from '../features/events/EventFilterBar';
import {
  EVENT_TEXT_FILTERS,
  eventQueryParams,
  readEventFilters,
} from '../features/events/event-filters';
import { OutcomeLabel } from '../features/events/OutcomeLabel';
import { displayUser } from '../features/alerts/entities';
import { Truncate } from '../components/ui/Truncate';
import { useFormat } from '../lib/format';
import { useParamUpdater } from '../lib/search-params';

const eventIdSchema = z.uuid();

export default function EventsPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const [params] = useSearchParams();
  const update = useParamUpdater();
  // The drawer is part of the URL too, so a link can open one event; it does not filter.
  const listSearch = useMemo(() => {
    const copy = new URLSearchParams(params);
    copy.delete('event');
    return copy.toString();
  }, [params]);
  const filters = useMemo(() => readEventFilters(new URLSearchParams(listSearch)), [listSearch]);
  const query = useMemo(() => eventQueryParams(filters), [filters]);
  const list = useEventsList(query);
  const events = flattenPages(list.data);
  const openId = eventIdSchema.safeParse(params.get('event'));

  const columns: Array<Column<NormalizedEvent>> = [
    {
      id: 'time',
      header: t('events.table.time'),
      cell: (event) => (
        <time dateTime={event.ts} title={format.dateTime(event.ts)} className="whitespace-nowrap">
          {format.eventTime(event.ts)}
        </time>
      ),
      className: 'w-40',
    },
    {
      id: 'source',
      header: t('events.table.source'),
      cell: (event) => t(`sources.${event.source}`),
      className: 'hidden 2xl:table-cell whitespace-nowrap w-40',
    },
    {
      id: 'host',
      header: t('events.table.host'),
      cell: (event) => <Truncate text={event.host} className="max-w-[9rem]" />,
      className: 'w-36',
    },
    {
      id: 'action',
      header: t('events.table.action'),
      cell: (event) => <Truncate text={event.action} mono className="max-w-[11rem]" />,
      className: 'w-44',
    },
    {
      id: 'outcome',
      header: t('events.table.outcome'),
      cell: (event) => <OutcomeLabel outcome={event.outcome} />,
      className: 'hidden sm:table-cell w-32',
    },
    {
      id: 'user',
      header: t('events.table.user'),
      cell: (event) => (
        <Truncate text={displayUser(event) ?? t('common.none')} className="max-w-[10rem]" />
      ),
      className: 'hidden md:table-cell w-40',
    },
    {
      id: 'srcIp',
      header: t('events.table.srcIp'),
      cell: (event) => <span className="whitespace-nowrap">{event.srcIp ?? t('common.none')}</span>,
      className: 'hidden md:table-cell w-36',
    },
    {
      id: 'message',
      header: t('events.table.message'),
      cell: (event) => <Truncate text={event.message} mono className="max-w-[40rem]" />,
      className: 'hidden xl:table-cell',
    },
  ];

  return (
    <section>
      <PageHeader title={t('pages.events.title')} description={t('pages.events.description')} />
      <EventFilterBar
        key={EVENT_TEXT_FILTERS.map((key) => filters.text[key] ?? '').join('|')}
        filters={filters}
      />
      {list.isPending ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState title={t('events.empty.title')} description={t('events.empty.description')} />
      ) : (
        <>
          <DataTable
            caption={t('events.table.caption')}
            columns={columns}
            rows={events}
            getRowId={(event) => event.id}
            rowLabel={(event) => `${event.host} ${event.action} ${format.dateTime(event.ts)}`}
            onOpen={(event) => update({ event: event.id })}
          />
          <LoadMore
            shown={events.length}
            hasMore={list.hasNextPage}
            loading={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
          />
        </>
      )}
      {openId.success ? (
        <EventDrawer id={openId.data} onClose={() => update({ event: undefined })} />
      ) : null}
    </section>
  );
}
