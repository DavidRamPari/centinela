import type { NormalizedEvent } from '@centinela/shared';
import { useTranslation } from 'react-i18next';
import { useEvent } from '../../api/hooks';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { DescriptionList } from '../../components/ui/DescriptionList';
import { Drawer } from '../../components/ui/Drawer';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { useFormat } from '../../lib/format';
import { OutcomeLabel } from './OutcomeLabel';

/** Event detail: normalized fields, the rule-matching field view and the raw message. */
export function EventDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const event = useEvent(id);
  return (
    <Drawer title={t('events.drawer.title')} onClose={onClose}>
      {event.isPending ? (
        <LoadingState />
      ) : event.isError ? (
        <ErrorState error={event.error} onRetry={() => void event.refetch()} />
      ) : (
        <EventDetail event={event.data} />
      )}
    </Drawer>
  );
}

function EventDetail({ event }: { event: NormalizedEvent }) {
  const { t } = useTranslation();
  const format = useFormat();
  const fields = Object.entries(event.fields).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {t('events.drawer.normalized')}
        </h3>
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
              value: <span className="font-mono">{event.host}</span>,
            },
            { term: t('events.drawer.category'), value: t(`categories.${event.category}`) },
            {
              term: t('events.table.action'),
              value: <span className="font-mono">{event.action}</span>,
            },
            { term: t('events.table.outcome'), value: <OutcomeLabel outcome={event.outcome} /> },
            {
              term: t('events.table.user'),
              value: <span className="break-all font-mono">{event.user ?? '—'}</span>,
            },
            {
              term: t('events.table.srcIp'),
              value: <span className="font-mono">{event.srcIp ?? '—'}</span>,
            },
            {
              term: t('events.drawer.srcPort'),
              value: <span className="font-mono">{event.srcPort ?? '—'}</span>,
            },
            {
              term: t('events.drawer.logsources'),
              value: (
                <span className="font-mono text-xs">
                  {event.logsources
                    .map((ls) =>
                      Object.entries(ls)
                        .map(([key, value]) => `${key}:${value}`)
                        .join(' '),
                    )
                    .join(' · ')}
                </span>
              ),
            },
            {
              term: t('events.drawer.id'),
              value: <span className="break-all font-mono text-xs">{event.id}</span>,
            },
          ]}
        />
      </section>
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {t('events.drawer.raw')}
        </h3>
        <CodeBlock text={event.message} label={t('events.drawer.raw')} />
        <p className="mt-1 text-xs text-muted">
          {t('events.drawer.length', { value: format.number(event.message.length) })}
        </p>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {t('events.drawer.fields')}
        </h3>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{t('events.drawer.fields')}</caption>
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('events.drawer.field')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('events.drawer.value')}
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map(([key, value]) => (
                <tr key={key} className="border-t border-line align-top">
                  <th
                    scope="row"
                    className="whitespace-nowrap px-2 py-1 font-mono font-normal text-muted"
                  >
                    {key}
                  </th>
                  <td className="break-all px-2 py-1 font-mono">
                    {value === null ? 'null' : String(value)}
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
