/**
 * Placeholders for the Overview's figures, charts and ranked lists, the same size as what
 * replaces them (S7b-17). Labels and headings stay real; only the numbers are placeholders.
 */
import { clsx } from 'clsx';
import { Skeleton, SkeletonText } from '../../components/ui/Skeleton';
import { lineWidth } from '../../components/ui/skeleton-widths';

/** A total with its label and trend sentence (`TrendStat`). */
export function TrendStatSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-0.5" aria-hidden="true">
      <p className="text-muted">{label}</p>
      <p className="flex h-9 items-center">
        <Skeleton className="h-6 w-24 rounded-badge" />
      </p>
      <SkeletonText className="w-3/5" />
    </div>
  );
}

/** Bar heights for the chart placeholder: a calm, made-up shape, the same on every render. */
const BARS = [
  'h-1/5',
  'h-1/4',
  'h-1/3',
  'h-1/4',
  'h-2/5',
  'h-1/2',
  'h-1/3',
  'h-3/5',
  'h-2/5',
  'h-1/4',
  'h-1/3',
  'h-1/5',
] as const;

/**
 * A chart (`TimeSeriesChart`): the same 11 rem box, a baseline where the x axis is and
 * the room the y axis takes, with bars or a low band in place of the series.
 */
export function ChartSkeleton({ kind }: { kind: 'area' | 'bar' }) {
  return (
    <div className="flex h-44 flex-col pt-2" aria-hidden="true">
      <div className="ml-10 flex flex-1 items-end gap-1.5 border-b border-line">
        {kind === 'bar' ? (
          BARS.map((height, index) => (
            <Skeleton key={index} className={clsx('flex-1 rounded-t-[2px]', height)} />
          ))
        ) : (
          <Skeleton className="h-2/5 w-full rounded-t-panel" />
        )}
      </div>
      <div className="ml-10 flex h-[30px] items-center justify-between">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-2.5 w-10 rounded-badge" />
        ))}
      </div>
    </div>
  );
}

/** A ranked list with inline bars (`BarList`). */
export function BarListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="flex flex-col gap-2.5" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1">
              <SkeletonText className={lineWidth(index)} />
            </span>
            <span className="w-8 shrink-0">
              <SkeletonText className="w-full" />
            </span>
          </div>
          <Skeleton className="h-1" />
        </li>
      ))}
    </ul>
  );
}
