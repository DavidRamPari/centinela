import type { AttackResponse } from '@centinela/shared';
import { clsx } from 'clsx';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAttackMatrix } from '../api/hooks';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { TimeRangeSelect } from '../components/ui/TimeRangeSelect';
import { HEAT_CLASSES, heatLevel } from '../features/attack/heat';
import { useFormat } from '../lib/format';
import { useParamUpdater } from '../lib/search-params';
import { rangeQuery, readTimeRange, writeTimeRange, type TimeRange } from '../lib/time-range';

type Mode = 'alerts' | 'coverage';
type Technique = AttackResponse['tactics'][number]['techniques'][number];

/** Range params to carry from the matrix to the list a cell links to. */
function rangeSearch(range: TimeRange): URLSearchParams {
  return writeTimeRange(new URLSearchParams(), range);
}

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
  const activeOnly = params.get('active') === '1';

  const value = (technique: Technique) => (mode === 'alerts' ? technique.alerts : technique.rules);
  const tactics = matrix.data?.tactics ?? [];
  const max = Math.max(0, ...tactics.flatMap((tactic) => tactic.techniques.map(value)));

  function cellHref(technique: Technique): string {
    if (mode === 'coverage') return `/rules?technique=${technique.id}`;
    const next = rangeSearch(range);
    next.set('technique', technique.id);
    return `/alerts?${next.toString()}`;
  }

  return (
    <section>
      <PageHeader title={t('pages.attack.title')} description={t('pages.attack.description')} />
      <div className="mb-4 flex flex-wrap items-end gap-4 rounded-lg border border-line bg-surface p-3">
        <TimeRangeSelect
          value={range}
          onChange={(next) => update((current) => writeTimeRange(current, next))}
        />
        <div
          role="group"
          aria-label={t('attack.mode.label')}
          className="flex rounded-md border border-line p-0.5"
        >
          {(['alerts', 'coverage'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => update({ view: option === 'coverage' ? 'coverage' : undefined })}
              className={clsx(
                'rounded px-3 py-1 text-xs font-medium',
                mode === option ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
              )}
            >
              {t(`attack.mode.${option}`)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(event) => update({ active: event.target.checked ? '1' : undefined })}
          />
          {t('attack.activeOnly')}
        </label>
        <Legend max={max} mode={mode} />
      </div>

      {matrix.isPending ? (
        <LoadingState />
      ) : matrix.isError ? (
        <ErrorState error={matrix.error} onRetry={() => void matrix.refetch()} />
      ) : tactics.length === 0 ? (
        <EmptyState title={t('attack.empty')} />
      ) : (
        <div className="overflow-x-auto pb-2" tabIndex={0} aria-label={t('attack.matrix')}>
          <div className="grid auto-cols-[minmax(11rem,1fr)] grid-flow-col gap-2">
            {tactics.map((tactic) => {
              const techniques = activeOnly
                ? tactic.techniques.filter((tech) => value(tech) > 0)
                : tactic.techniques;
              const active = tactic.techniques.filter((tech) => value(tech) > 0).length;
              return (
                <section
                  key={tactic.id}
                  aria-labelledby={`tactic-${tactic.id}`}
                  className="flex min-w-0 flex-col gap-1"
                >
                  <header className="rounded-md border border-line bg-surface-2 px-2 py-1.5">
                    <h2 id={`tactic-${tactic.id}`} className="text-xs font-semibold text-fg">
                      {tactic.name}
                    </h2>
                    <p className="text-[11px] text-muted">
                      {t('attack.techniquesActive', {
                        value: format.number(active),
                        total: format.number(tactic.techniques.length),
                      })}
                    </p>
                  </header>
                  <ul className="flex flex-col gap-1">
                    {techniques.map((technique) => {
                      const count = value(technique);
                      const sub = technique.id.includes('.');
                      return (
                        <li key={technique.id} className={sub ? 'ml-3' : undefined}>
                          <Link
                            to={cellHref(technique)}
                            data-technique={technique.id}
                            className={clsx(
                              'block rounded px-2 py-1 text-[11px] leading-tight hover:ring-2 hover:ring-accent',
                              HEAT_CLASSES[heatLevel(count, max)],
                            )}
                          >
                            <span className="font-mono">{technique.id}</span> {technique.name}
                            <span className="mt-0.5 block font-semibold">
                              {t(mode === 'alerts' ? 'attack.alertsCount' : 'attack.rulesCount', {
                                value: format.number(count),
                              })}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/** Color scale explained in text, so the heatmap is readable without color. */
function Legend({ max, mode }: { max: number; mode: Mode }) {
  const { t } = useTranslation();
  const format = useFormat();
  const steps = [0, 1, 2, 3, 4] as const;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">
        {t('attack.legend', { value: format.number(max) })}
      </span>
      <ul
        className="flex gap-1"
        aria-label={t(mode === 'alerts' ? 'attack.legendAlerts' : 'attack.legendRules')}
      >
        {steps.map((step) => (
          <li key={step} className={clsx('rounded px-2 py-0.5 text-[11px]', HEAT_CLASSES[step])}>
            {step === 0 ? '0' : `≤ ${format.number(Math.ceil((max * step) / 4))}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
