import type { NormalizedEvent } from '@centinela/shared';
import { useTranslation } from 'react-i18next';
import { useEvent } from '../../api/hooks';
import type { ReactNode } from 'react';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { CopyButton } from '../../components/ui/CopyButton';
import { DescriptionList } from '../../components/ui/DescriptionList';
import { Drawer } from '../../components/ui/Drawer';
import { LoadingRegion, Skeleton, SkeletonText } from '../../components/ui/Skeleton';
import { lineWidth } from '../../components/ui/skeleton-widths';
import { ErrorState } from '../../components/ui/States';
import { useFormat } from '../../lib/format';
import { OutcomeLabel } from './OutcomeLabel';
import { displayUser } from '../alerts/entities';

/** Event detail: normalized fields, the rule-matching field view and the raw message. */
export function EventDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const event = useEvent(id);
  return (
    <Drawer title={t('events.drawer.title')} onClose={onClose}>
      {event.data !== undefined ? (
        <EventDetail event={event.data} />
      ) : event.isError ? (
        <ErrorState error={event.error} onRetry={() => event.refetch()} />
      ) : (
        <EventSkeleton />
      )}
    </Drawer>
  );
}

function EventDetail({ event }: { event: NormalizedEvent }) {
  const { t } = useTranslation();
  const format = useFormat();
  const fields = Object.entries(event.fields).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h3 className="mb-3 font-semibold text-fg">{t('events.drawer.normalized')}</h3>
        <DescriptionList
          items={[
            {
              term: t('events.table.time'),
              value: <time dateTime={event.ts}>{format.dateTime(event.ts)}</time>,
            },
            {
              term: t('events.drawer.ingestedAt'),
              value: <time dateTime={event.ingestedAt}>{format.dateTime(event.ingestedAt)}</time>,
            },
            { term: t('events.table.source'), value: t(`sources.${event.source}`) },
            {
              term: t('events.table.host'),
              value: <Copyable value={event.host} />,
            },
            { term: t('events.drawer.category'), value: t(`categories.${event.category}`) },
            {
              term: t('events.table.action'),
              value: <span className="font-mono">{event.action}</span>,
            },
            { term: t('events.table.outcome'), value: <OutcomeLabel outcome={event.outcome} /> },
            {
              term: t('events.table.user'),
              value: <Copyable value={displayUser(event)} />,
            },
            {
              term: t('events.table.srcIp'),
              value: <Copyable value={event.srcIp} />,
            },
            {
              term: t('events.drawer.srcPort'),
              value: event.srcPort ?? t('common.none'),
            },
            {
              term: t('events.drawer.logsources'),
              value: (
                <ul className="flex flex-col gap-0.5 font-mono text-small">
                  {event.logsources.map((ls) => {
                    const text = Object.entries(ls)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(', ');
                    return <li key={text}>{text}</li>;
                  })}
                </ul>
              ),
            },
            {
              term: t('events.drawer.id'),
              value: <Copyable value={event.id} mono />,
            },
          ]}
        />
      </section>
      <section>
        <h3 className="mb-3 font-semibold text-fg">{t('events.drawer.raw')}</h3>
        <CodeBlock text={event.message} label={t('events.drawer.raw')} />
        <p className="mt-1.5 text-small text-muted">
          {t('events.drawer.length', { value: format.number(event.message.length) })}
        </p>
      </section>
      <section>
        <h3 className="mb-1 font-semibold text-fg">{t('events.drawer.fields')}</h3>
        <p className="mb-3 text-muted">{t('events.drawer.fieldsHint')}</p>
        <div className="relative overflow-x-auto">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{t('events.drawer.fields')}</caption>
            <thead className="text-muted">
              <tr className="border-b border-line-strong">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('events.drawer.field')}
                </th>
                <th scope="col" className="py-2 font-semibold">
                  {t('events.drawer.value')}
                </th>
                <th scope="col" className="py-2 pl-2">
                  <span className="sr-only">{t('events.drawer.copy')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map(([key, value]) => (
                <tr key={key} className="border-b border-line align-top">
                  <th
                    scope="row"
                    className="whitespace-nowrap py-1.5 pr-4 font-mono font-normal text-muted"
                  >
                    {key}
                  </th>
                  <td className="break-all py-1.5 font-mono text-fg">
                    {value === null ? 'null' : String(value)}
                  </td>
                  <td className="py-0.5 pl-2 whitespace-nowrap">
                    {value === null ? null : (
                      <CopyButton
                        value={String(value)}
                        label={t('events.drawer.copyField', { field: key })}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** A value with a copy button, or "—" when there is none. */
function Copyable({ value, mono = false }: { value: string | null | undefined; mono?: boolean }) {
  const { t } = useTranslation();
  if (value === null || value === undefined || value === '') return <>{t('common.none')}</>;
  return (
    <span className="flex items-center gap-0.5">
      <span className={mono ? 'break-all font-mono text-small' : 'break-all'}>{value}</span>
      <CopyButton value={value} />
    </span>
  );
}

/** The drawer before the event loads: real field names, placeholder values. */
function EventSkeleton() {
  const { t } = useTranslation();
  const terms = [
    t('events.table.time'),
    t('events.drawer.ingestedAt'),
    t('events.table.source'),
    t('events.table.host'),
    t('events.drawer.category'),
    t('events.table.action'),
    t('events.table.outcome'),
    t('events.table.user'),
    t('events.table.srcIp'),
    t('events.drawer.srcPort'),
  ];
  const rows: Array<{ term: string; value: ReactNode }> = terms.map((term, index) => ({
    term,
    value: <SkeletonText className={lineWidth(index)} />,
  }));
  return (
    <LoadingRegion label={t('events.drawer.loading')} className="flex flex-col gap-8">
      <section>
        <h3 className="mb-3 font-semibold text-fg">{t('events.drawer.normalized')}</h3>
        <DescriptionList items={rows} />
      </section>
      <section>
        <h3 className="mb-3 font-semibold text-fg">{t('events.drawer.raw')}</h3>
        <Skeleton className="h-16 rounded-control" />
      </section>
    </LoadingRegion>
  );
}
