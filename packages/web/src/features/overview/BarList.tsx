import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { useFormat } from '../../lib/format';

interface BarListProps {
  items: ReadonlyArray<{ key: string; label: ReactNode; count: number }>;
  empty: string;
  renderLabel?: (item: { key: string; label: ReactNode }) => ReactNode;
  /** Bar colour class per item (severity lists); defaults to the structure blue. */
  barClass?: (key: string) => string;
}

/** Ranked list with inline bars: the number is always shown as text. */
export function BarList({ items, empty, renderLabel, barClass }: BarListProps) {
  const format = useFormat();
  if (items.length === 0) return <p className="text-muted">{empty}</p>;
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span
              className="min-w-0 truncate"
              title={typeof item.label === 'string' ? item.label : undefined}
            >
              {renderLabel ? renderLabel(item) : item.label}
            </span>
            <span className="shrink-0 font-semibold text-fg">{format.number(item.count)}</span>
          </div>
          <div className="h-1 bg-sev-off/60" aria-hidden="true">
            <div
              className={clsx('h-full', barClass?.(item.key) ?? 'bg-line-strong')}
              style={{ width: `${Math.max((item.count / max) * 100, item.count > 0 ? 1.5 : 0)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
