import type { NormalizedEvent } from '@centinela/shared';
import { clsx } from 'clsx';
import { ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { OutcomeIcon } from '../../events/OutcomeLabel';
import { useFormat } from '../../../lib/format';
import { displayUser } from '../entities';
import { groupTimeline, whatKey, type TimelineGroup } from './group';

/** "46 failed sign-ins from 203.0.113.77 as deploy" or "… for 25 users", for a group. */
function useDescribe() {
  const { t } = useTranslation();
  return (events: readonly NormalizedEvent[]) => {
    const first = events[0];
    if (!first) return '';
    const what = t(`timeline.what.${whatKey(first)}`, {
      count: events.length,
      action: first.action,
    });
    const users = [...new Set(events.map(displayUser).filter((user) => user !== undefined))];
    const user =
      users.length === 1
        ? t('timeline.forUser', { user: users[0] })
        : users.length > 1
          ? t('timeline.forUsers', { count: users.length })
          : '';
    return [what, first.srcIp ? t('timeline.fromIp', { ip: first.srcIp }) : '', user]
      .filter(Boolean)
      .join(' ');
  };
}

/**
 * The events behind an alert, oldest first, with identical consecutive events folded into
 * one line that expands (docs/decisions/S7b.md). Raw lines are text, never markup.
 */
export function Timeline({ events }: { events: readonly NormalizedEvent[] }) {
  const { t } = useTranslation();
  if (events.length === 0) return <p className="text-muted">{t('alertDetail.timeline.empty')}</p>;
  const groups = groupTimeline(events);
  return (
    <ol className="flex flex-col">
      {groups.map((group) =>
        group.events.length === 1 && group.events[0] ? (
          <SingleEvent key={group.key} event={group.events[0]} />
        ) : (
          <GroupedEvents key={group.key} group={group} />
        ),
      )}
    </ol>
  );
}

function Row({ time, children }: { time: string; children: React.ReactNode }) {
  const format = useFormat();
  return (
    <li className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 border-b border-line py-3 last:border-b-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <time dateTime={time} title={format.dateTime(time)} className="pt-px text-muted">
        {format.timeWithSeconds(time)}
      </time>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </li>
  );
}

function SingleEvent({ event }: { event: NormalizedEvent }) {
  const { t } = useTranslation();
  const describe = useDescribe();
  return (
    <Row time={event.ts}>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-start gap-2 font-semibold text-fg">
          <OutcomeIcon outcome={event.outcome} className="mt-0.5" />
          {describe([event])}
        </span>
        <Link to={`/events?event=${event.id}`} className={eventLink}>
          {t('alertDetail.timeline.open')}
        </Link>
      </p>
      <p className="line-clamp-2 font-mono text-small break-all text-muted">{event.message}</p>
    </Row>
  );
}

function GroupedEvents({ group }: { group: TimelineGroup }) {
  const { t } = useTranslation();
  const format = useFormat();
  const describe = useDescribe();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const first = group.events[0];
  if (!first) return null;
  return (
    <Row time={group.first}>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-start gap-2 font-semibold text-fg">
          <OutcomeIcon outcome={first.outcome} className="mt-0.5" />
          <span>
            {describe(group.events)}{' '}
            <span className="font-normal text-muted">
              {t('timeline.between', {
                from: format.timeWithSeconds(group.first),
                to: format.timeWithSeconds(group.last),
              })}
            </span>
          </span>
        </span>
      </p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className="ml-4.5 inline-flex h-8 w-fit items-center gap-1 rounded-control px-1.5 font-semibold text-link transition-colors duration-100 hover:bg-hover active:bg-pressed"
      >
        <ChevronRight
          aria-hidden="true"
          strokeWidth={2}
          className={clsx('size-4 transition-transform duration-100', open && 'rotate-90')}
        />
        {open
          ? t('timeline.hide', { count: group.events.length })
          : t('timeline.show', { count: group.events.length })}
      </button>
      {open ? (
        <ol
          id={listId}
          className="mt-1 flex animate-expand-in flex-col border-l border-line-strong pl-4"
        >
          {group.events.map((event) => (
            <li key={event.id} className="flex flex-col gap-0.5 py-1.5">
              <span className="flex flex-wrap items-baseline gap-x-3">
                <time dateTime={event.ts} className="text-small text-muted">
                  {format.timeWithSeconds(event.ts)}
                </time>
                <Link to={`/events?event=${event.id}`} className={clsx(eventLink, 'text-small')}>
                  {t('alertDetail.timeline.open')}
                </Link>
              </span>
              <span className="line-clamp-2 font-mono text-small break-all text-muted">
                {event.message}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </Row>
  );
}

const eventLink =
  'text-link underline decoration-transparent underline-offset-3 hover:decoration-link';
