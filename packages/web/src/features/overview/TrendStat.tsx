import { useTranslation } from 'react-i18next';
import { useFormat } from '../../lib/format';
import { trend } from '../../lib/time-range';

/**
 * A total and how it compares with the previous period of the same length, in words
 * ("12% more than the previous 24 hours"), neutral in colour: more events is not bad news
 * by itself, and red is kept for danger.
 */
export function TrendStat({
  label,
  value,
  previous,
  periodLabel,
}: {
  label: string;
  value: number;
  /** Total of the previous period; undefined while it loads or when it failed. */
  previous: number | undefined;
  /** "the previous 24 hours" */
  periodLabel: string;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const change = previous === undefined ? undefined : trend(value, previous);
  let sentence = '';
  if (change?.kind === 'none') sentence = t('overview.trend.none', { period: periodLabel });
  if (change?.kind === 'same') sentence = t('overview.trend.same', { period: periodLabel });
  if (change?.kind === 'up' || change?.kind === 'down') {
    sentence = t(change.kind === 'up' ? 'overview.trend.up' : 'overview.trend.down', {
      percent: format.number(change.percent),
      period: periodLabel,
    });
  }
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted">{label}</p>
      <p className="text-[1.75rem] leading-9 font-semibold text-fg">{format.number(value)}</p>
      <p className="min-h-5 text-muted">{sentence}</p>
    </div>
  );
}
