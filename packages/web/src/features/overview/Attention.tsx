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
import { Skeleton, SkeletonText } from '../../components/ui/Skeleton';
import { lineWidth } from '../../components/ui/skeleton-widths';
import { byUrgency } from './urgency';
import { EmptyState } from '../../components/ui/States';
import { useFormat } from '../../lib/format';
import { primaryEntity } from '../alerts/entities';
import { useFreshAlerts } from '../live/live-context';

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
  const fresh = useFreshAlerts();

  return (
    <section aria-labelledby="attention-title" className={FRAME}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <AttentionHeading rangeLabel={rangeLabel} />
        {newAlerts.length > 0 ? (
          <Link
            to={reviewHref}
            className="inline-flex h-10 items-center rounded-control border border-accent-edge bg-accent px-3.5 font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent-hover active:translate-y-px active:bg-accent-pressed"
          >
            {t('overview.attention.review')}
          </Link>
        ) : null}
      </div>

      <dl className={SCORES}>
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
                <AttentionRow key={alert.id} alert={alert} fresh={fresh.has(alert.id)} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

const FRAME = '@container answer-frame px-4 py-5 sm:px-7 sm:py-7';
const SCORES = 'mt-6 grid grid-cols-2 gap-x-6 gap-y-6 @2xl:grid-cols-4';
/** Height of the scoreboard's Corridor numerals, in pixels. */
const SCORE_HEIGHT = 44;

function AttentionHeading({ rangeLabel }: { rangeLabel: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <h2 id="attention-title" className="text-lead font-semibold text-fg">
        {t('overview.attention.title')}
      </h2>
      <p className="mt-0.5 text-muted">{t('overview.attention.subtitle', { range: rangeLabel })}</p>
    </div>
  );
}

/**
 * The scoreboard before its first answer: the same frame, headings and labels, with
 * placeholders where the numbers and the alerts go (S7b-17). Place it in a `LoadingRegion`.
 */
export function AttentionSkeleton({ rangeLabel }: { rangeLabel: string }) {
  const { t } = useTranslation();
  const labels = [
    t('overview.attention.new'),
    t('overview.attention.critical'),
    t('overview.attention.high'),
    t('overview.attention.acknowledged'),
  ];
  return (
    <div className={FRAME}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <AttentionHeading rangeLabel={rangeLabel} />
        <Skeleton className="h-10 w-40 rounded-control" />
      </div>
      <div className={SCORES} aria-hidden="true">
        {labels.map((label) => (
          <div key={label} className="flex flex-col-reverse justify-end gap-2">
            <span className="text-muted">{label}</span>
            {/* Inline, like the Corridor numeral's SVG, so it takes the same line box. */}
            <span>
              <Skeleton inline className="h-[44px] w-16 rounded-panel" />
            </span>
          </div>
        ))}
      </div>
      <div className="mt-7 border-t border-line pt-5" aria-hidden="true">
        <p className="mb-2 font-semibold text-fg">{t('overview.attention.startHere')}</p>
        <ul className="flex flex-col">
          {[0, 1, 2, 3, 4].map((index) => (
            <li key={index} className="border-b border-line py-3 last:border-b-0">
              <span className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 @3xl:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,14rem)_8rem]">
                <SkeletonText className="w-20" />
                {/* Titles take two lines in a narrow frame. */}
                <span className="flex flex-col">
                  <SkeletonText className={lineWidth(index)} />
                  <span className="@xl:hidden">
                    <SkeletonText className="w-1/2" />
                  </span>
                </span>
                <span className="col-start-2 @3xl:col-start-auto">
                  <SkeletonText className="w-1/2" />
                </span>
                <span className="col-start-2 @3xl:col-start-auto">
                  <SkeletonText className="w-16 @3xl:ml-auto" />
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
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
        <CorridorNumber text={value} height={SCORE_HEIGHT} />
      </dd>
    </div>
  );
}

function AttentionRow({ alert, fresh }: { alert: Alert; fresh: boolean }) {
  const { t } = useTranslation();
  const format = useFormat();
  const entity = primaryEntity(alert);
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        to={`/alerts/${alert.id}`}
        className={clsx(
          'group -mx-2 grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-0.5 rounded-control px-2 py-3 transition-[background-color,box-shadow] duration-150 ease-out hover:bg-hover active:bg-pressed @3xl:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,14rem)_8rem]',
          fresh && 'bg-arrive shadow-[inset_3px_0_0_var(--c-info)]',
        )}
        data-fresh={fresh || undefined}
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
