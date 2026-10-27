/**
 * The Overview's first answer: what needs attention now. A scoreboard of new alerts in
 * Corridor numerals inside the page's one framed area, then the new alerts to start with,
 * most severe first (docs/decisions/S7b.md).
 */
import type { Alert } from '@centinela/shared';
import { clsx } from 'clsx';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CorridorNumber } from '../../components/brand/CorridorNumber';
import { LevelPips } from '../../components/ui/Badges';
import { byUrgency } from './urgency';
import { EmptyState } from '../../components/ui/States';
import { useFormat } from '../../lib/format';
import { primaryEntity } from '../alerts/entities';

interface AttentionProps {
  newAlerts: readonly Alert[];
  /** The page of new alerts was cut at the limit: counts are "at least". */
  more: boolean;
  acknowledged: number;
  /** Link to the alerts list filtered on new alerts in the same range. */
  reviewHref: string;
  rangeLabel: string;
}

export function AttentionScoreboard({
  newAlerts,
  more,
  acknowledged,
  reviewHref,
  rangeLabel,
}: AttentionProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const critical = newAlerts.filter((alert) => alert.level === 'critical').length;
  const high = newAlerts.filter((alert) => alert.level === 'high').length;
  const count = (value: number) => `${format.number(value)}${more ? '+' : ''}`;
  const top = byUrgency(newAlerts).slice(0, 5);

  return (
    <section
      aria-labelledby="attention-title"
      className="@container answer-frame px-4 py-5 sm:px-7 sm:py-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h2 id="attention-title" className="text-lead font-semibold text-fg">
            {t('overview.attention.title')}
          </h2>
          <p className="mt-0.5 text-muted">
            {t('overview.attention.subtitle', { range: rangeLabel })}
          </p>
        </div>
        {newAlerts.length > 0 ? (
          <Link
            to={reviewHref}
            className="inline-flex h-10 items-center rounded-control border border-accent-edge bg-accent px-3.5 font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent-hover active:translate-y-px active:bg-accent-pressed"
          >
            {t('overview.attention.review')}
          </Link>
        ) : null}
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-6 @2xl:grid-cols-4">
        <Score label={t('overview.attention.new')} value={count(newAlerts.length)} tone="fg" />
        <Score
          label={t('overview.attention.critical')}
          value={count(critical)}
          tone={critical > 0 ? 'critical' : 'fg'}
        />
        <Score label={t('overview.attention.high')} value={count(high)} tone="fg" />
        <Score
          label={t('overview.attention.acknowledged')}
          value={format.number(acknowledged)}
          tone="muted"
        />
      </dl>

      <div className="mt-7 border-t border-line pt-5">
        {top.length === 0 ? (
          <EmptyState
            compact
            icon={ShieldCheck}
            title={t('overview.attention.clearTitle')}
            description={t('overview.attention.clearDescription')}
          />
        ) : (
          <>
            <h3 className="mb-2 font-semibold text-fg">{t('overview.attention.startHere')}</h3>
            <ul className="flex flex-col">
              {top.map((alert) => (
                <AttentionRow key={alert.id} alert={alert} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function Score({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'fg' | 'critical' | 'muted';
}) {
  return (
    // The label comes first for screen readers, the number first on screen.
    <div className="flex flex-col-reverse justify-end gap-2">
      <dt className="text-muted">{label}</dt>
      <dd
        className={clsx(
          tone === 'critical' && 'text-sev-critical',
          tone === 'fg' && 'text-fg',
          tone === 'muted' && 'text-muted',
        )}
      >
        <CorridorNumber text={value} height={44} />
      </dd>
    </div>
  );
}

function AttentionRow({ alert }: { alert: Alert }) {
  const { t } = useTranslation();
  const format = useFormat();
  const entity = primaryEntity(alert);
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        to={`/alerts/${alert.id}`}
        className="group -mx-2 grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-0.5 rounded-control px-2 py-3 hover:bg-hover @3xl:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,14rem)_8rem]"
      >
        <span className="inline-flex items-center gap-2 text-small font-semibold">
          <LevelPips level={alert.level} />
          <span className={alert.level === 'critical' ? 'text-sev-critical' : 'text-fg'}>
            {t(`levels.${alert.level}`)}
          </span>
        </span>
        <span className="min-w-0 font-semibold text-fg group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-3">
          {alert.ruleTitle}
        </span>
        <span className="col-start-2 min-w-0 truncate text-muted @3xl:col-start-auto">
          {[alert.host, entity].filter(Boolean).join(', ')}
        </span>
        <time
          dateTime={alert.lastSeen}
          title={format.dateTime(alert.lastSeen)}
          className="col-start-2 text-muted @3xl:col-start-auto @3xl:text-right"
        >
          {format.relative(alert.lastSeen)}
        </time>
      </Link>
    </li>
  );
}
