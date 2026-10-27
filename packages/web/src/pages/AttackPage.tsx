import type { AttackResponse } from '@centinela/shared';
import { clsx } from 'clsx';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAttackMatrix } from '../api/hooks';
import { Checkbox, Segmented } from '../components/ui/Fields';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingRegion, Skeleton, SkeletonText } from '../components/ui/Skeleton';
import { lineWidth } from '../components/ui/skeleton-widths';
import { EmptyState, ErrorState, RefreshFailed, Updating } from '../components/ui/States';
import { TimeRangeSelect } from '../components/ui/TimeRangeSelect';
import { HEAT_CLASSES, heatLevel } from '../features/attack/heat';
import { useFormat } from '../lib/format';
import { useParamUpdater } from '../lib/search-params';
import { rangeQuery, readTimeRange, writeTimeRange, type TimeRange } from '../lib/time-range';
import { useDocumentTitle } from '../lib/document-title';

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
  useDocumentTitle(t('pages.attack.title'));
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
        {max > 0 ? (
          <Legend max={max} mode={mode} />
        ) : matrix.isPending ? (
          <LegendSkeleton mode={mode} />
        ) : null}
      </div>

      {matrix.data === undefined ? (
        matrix.isError ? (
          <ErrorState error={matrix.error} onRetry={() => matrix.refetch()} />
        ) : (
          <MatrixSkeleton showAll={showAll} />
        )
      ) : (
        <>
          {matrix.isRefetchError ? (
            <RefreshFailed error={matrix.error} onRetry={() => matrix.refetch()} />
          ) : null}
          <Updating active={matrix.isPlaceholderData}>
            {visible.length === 0 ? (
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
                    className="grid gap-x-3"
                    // One column per visible tactic; they share the width and scroll only when
                    // the minimum no longer fits (React sets this through the CSSOM, CSP-safe).
                    style={{ gridTemplateColumns: matrixColumns(visible.length, showAll) }}
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
          </Updating>
        </>
      )}
    </section>
  );
}

/** Techniques per placeholder column: a made-up, uneven shape, the same on every render. */
const SKELETON_CELLS = [4, 2, 5, 3, 2, 4, 3, 1, 3, 2, 4, 2, 3, 2] as const;

/** Grid columns of the matrix, shared by the matrix and its placeholder. */
function matrixColumns(count: number, showAll: boolean): string {
  return `repeat(${count}, minmax(${showAll ? '10.5rem' : '8.5rem'}, 1fr))`;
}

/**
 * The matrix before its first answer: tactic columns with technique cells of the real
 * cell's height. The number of columns is a guess (all 14 tactics, or a typical 6).
 */
function MatrixSkeleton({ showAll }: { showAll: boolean }) {
  const { t } = useTranslation();
  const count = showAll ? 14 : 6;
  return (
    <LoadingRegion label={t('attack.loading')} className="overflow-x-hidden pb-3">
      <div
        aria-hidden="true"
        className="grid gap-x-3"
        style={{ gridTemplateColumns: matrixColumns(count, showAll) }}
      >
        {Array.from({ length: count }, (_, column) => (
          <div key={column} className="flex min-w-0 flex-col">
            <div className="mb-2 border-b border-line-strong pb-2">
              <SkeletonText className={lineWidth(column)} />
              <span className="block text-small">
                <SkeletonText className="w-1/2" />
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {Array.from({ length: SKELETON_CELLS[column] ?? 2 }, (_, cell) => (
                <Skeleton key={cell} className="h-[46px] rounded-badge" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** The legend's place while the matrix loads, so the controls do not move when it arrives. */
function LegendSkeleton({ mode }: { mode: Mode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5" aria-hidden="true">
      <span className="text-small font-semibold text-fg">
        {t(mode === 'alerts' ? 'attack.legendAlerts' : 'attack.legendRules')}
      </span>
      <span className="flex h-10 items-center gap-1">
        {[0, 1, 2, 3].map((step) => (
          <Skeleton key={step} className="h-7 w-6 rounded-badge" />
        ))}
      </span>
    </div>
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
                  // Hover is a neutral inner line, not a colour: the fill already carries the count.
                  'flex flex-col gap-0.5 rounded-badge px-2.5 py-1.5 leading-snug transition-shadow duration-100 hover:ring-1 hover:ring-line-hover hover:ring-inset active:ring-2',
                  HEAT_CLASSES[mode][level],
                  level === 0 && 'py-1',
                )}
              >
                <span className={clsx('text-small', level > 0 && 'font-semibold')}>
                  {technique.name}
                </span>{' '}
                <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-caption">
                  <span className="font-mono opacity-90">{technique.id}</span>{' '}
                  {level > 0 ? (
                    <span className="ml-auto font-semibold whitespace-nowrap">
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
