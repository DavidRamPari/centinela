import type { AttackResponse } from '@centinela/shared';
import { clsx } from 'clsx';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAttackMatrix } from '../api/hooks';
import { Checkbox, Segmented } from '../components/ui/Fields';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { TimeRangeSelect } from '../components/ui/TimeRangeSelect';
import { HEAT_CLASSES, heatLevel } from '../features/attack/heat';
import { useFormat } from '../lib/format';
import { useParamUpdater } from '../lib/search-params';
import { rangeQuery, readTimeRange, writeTimeRange, type TimeRange } from '../lib/time-range';

type Mode = 'alerts' | 'coverage';
type Tactic = AttackResponse['tactics'][number];
type Technique = Tactic['techniques'][number];

/** Range params to carry from the matrix to the list a cell links to. */
function rangeSearch(range: TimeRange): URLSearchParams {
  return writeTimeRange(new URLSearchParams(), range);
}

/**
 * ATT&CK: which techniques have we seen, and where are we blind? By default only techniques
 * with activity are shown, and tactics without any are folded away; "Show all techniques"
 * brings back the full matrix (`?all=1`).
 */
export default function AttackPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const [params] = useSearchParams();
  const update = useParamUpdater();
  const search = params.toString();
  const range = useMemo(() => readTimeRange(new URLSearchParams(search)), [search]);
  const query = useMemo(() => rangeQuery(range), [range]);
  const matrix = useAttackMatrix(query);
  const mode: Mode = params.get('view') === 'coverage' ? 'coverage' : 'alerts';
  const showAll = params.get('all') === '1';

  const value = (technique: Technique) => (mode === 'alerts' ? technique.alerts : technique.rules);
  const tactics = matrix.data?.tactics ?? [];
  const max = Math.max(0, ...tactics.flatMap((tactic) => tactic.techniques.map(value)));
  const visible = showAll
    ? tactics
    : tactics.filter((tactic) => tactic.techniques.some((tech) => value(tech) > 0));
  const hidden = tactics.length - visible.length;

  function cellHref(technique: Technique): string {
    if (mode === 'coverage') return `/rules?technique=${technique.id}`;
    const next = rangeSearch(range);
    next.set('technique', technique.id);
    return `/alerts?${next.toString()}`;
  }

  return (
    <section>
      <PageHeader title={t('pages.attack.title')} description={t('pages.attack.description')} />
      <div className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-4 border-b border-line pb-6">
        <TimeRangeSelect
          value={range}
          onChange={(next) => update((current) => writeTimeRange(current, next))}
        />
        <Segmented
          label={t('attack.mode.label')}
          value={mode}
          onChange={(option) => update({ view: option === 'coverage' ? 'coverage' : undefined })}
          options={[
            { value: 'alerts', label: t('attack.mode.alerts') },
            { value: 'coverage', label: t('attack.mode.coverage') },
          ]}
        />
        <Checkbox
          className="h-10"
          label={t('attack.showAll')}
          checked={showAll}
          onChange={(event) => update({ all: event.target.checked ? '1' : undefined })}
        />
        {max > 0 ? <Legend max={max} mode={mode} /> : null}
      </div>

      {matrix.isPending ? (
        <LoadingState />
      ) : matrix.isError ? (
        <ErrorState error={matrix.error} onRetry={() => void matrix.refetch()} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={t(mode === 'alerts' ? 'attack.emptyAlerts' : 'attack.empty')}
          description={mode === 'alerts' ? t('attack.emptyAlertsHint') : undefined}
        />
      ) : (
        <>
          {hidden > 0 ? (
            <p className="mb-4 text-muted">
              {t('attack.hiddenTactics', { count: hidden, value: format.number(hidden) })}
            </p>
          ) : null}
          <div className="overflow-x-auto pb-3" tabIndex={0} aria-label={t('attack.matrix')}>
            <div
              className={clsx(
                'grid grid-flow-col gap-x-3',
                showAll ? 'auto-cols-[minmax(10.5rem,1fr)]' : 'auto-cols-[minmax(10rem,1fr)]',
              )}
            >
              {visible.map((tactic) => (
                <TacticColumn
                  key={tactic.id}
                  tactic={tactic}
                  mode={mode}
                  max={max}
                  showAll={showAll}
                  value={value}
                  href={cellHref}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function TacticColumn({
  tactic,
  mode,
  max,
  showAll,
  value,
  href,
}: {
  tactic: Tactic;
  mode: Mode;
  max: number;
  showAll: boolean;
  value: (technique: Technique) => number;
  href: (technique: Technique) => string;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const active = tactic.techniques.filter((tech) => value(tech) > 0).length;
  const techniques = showAll
    ? tactic.techniques
    : tactic.techniques.filter((tech) => value(tech) > 0);
  return (
    <section aria-labelledby={`tactic-${tactic.id}`} className="flex min-w-0 flex-col">
      <header className="mb-2 border-b border-line-strong pb-2">
        <h2 id={`tactic-${tactic.id}`} className="font-semibold text-fg">
          {tactic.name}
        </h2>
        <p className="text-small text-muted">
          {t(mode === 'alerts' ? 'attack.activeAlerts' : 'attack.activeRules', {
            value: format.number(active),
            total: format.number(tactic.techniques.length),
          })}
        </p>
      </header>
      <ul className="flex flex-col gap-1">
        {techniques.map((technique) => {
          const count = value(technique);
          const level = heatLevel(count, max);
          const sub = technique.id.includes('.');
          return (
            <li key={technique.id} className={sub ? 'ml-3' : undefined}>
              <Link
                to={href(technique)}
                data-technique={technique.id}
                className={clsx(
                  'flex flex-col gap-0.5 rounded-badge px-2.5 py-1.5 leading-snug transition-colors duration-100 hover:outline-2 hover:outline-offset-1 hover:outline-link',
                  HEAT_CLASSES[mode][level],
                  level === 0 && 'py-1',
                )}
              >
                <span className={clsx('text-small', level > 0 && 'font-semibold')}>
                  {technique.name}
                </span>{' '}
                <span className="flex items-baseline justify-between gap-2 text-caption">
                  <span className="font-mono opacity-90">{technique.id}</span>{' '}
                  {level > 0 ? (
                    <span className="font-semibold">
                      {t(mode === 'alerts' ? 'attack.alertsCount' : 'attack.rulesCount', {
                        count,
                        value: format.number(count),
                      })}
                    </span>
                  ) : (
                    <span className="sr-only">
                      {t(mode === 'alerts' ? 'attack.alertsCount' : 'attack.rulesCount', {
                        count,
                        value: format.number(count),
                      })}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
        {techniques.length === 0 ? (
          <li className="py-1 text-small text-muted">{t('attack.none')}</li>
        ) : null}
      </ul>
    </section>
  );
}

/** Colour scale explained in text, so the heatmap is readable without colour. */
function Legend({ max, mode }: { max: number; mode: Mode }) {
  const { t } = useTranslation();
  const format = useFormat();
  const steps = [1, 2, 3, 4] as const;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-semibold text-fg">
        {t(mode === 'alerts' ? 'attack.legendAlerts' : 'attack.legendRules')}
      </span>
      <ul className="flex h-10 items-center gap-1">
        {steps.map((step) => {
          // The counts heatLevel() puts in this step: (step - 1) / 4 of max < count <= step / 4.
          const low = Math.floor((max * (step - 1)) / 4) + 1;
          const high = Math.floor((max * step) / 4);
          if (low > high) return null;
          return (
            <li
              key={step}
              className={clsx(
                'rounded-badge px-2 py-1 text-small font-semibold',
                HEAT_CLASSES[mode][step],
              )}
            >
              {low >= high ? format.number(high) : `${format.number(low)}–${format.number(high)}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
