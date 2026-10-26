import type { ReactNode } from 'react';
import { useFormat } from '../../lib/format';

interface BarListProps {
  items: ReadonlyArray<{ key: string; label: ReactNode; count: number; href?: string }>;
  empty: string;
  renderLabel?: (item: { key: string; label: ReactNode }) => ReactNode;
}

/** Ranked list with inline bars: the number is always shown as text. */
export function BarList({ items, empty, renderLabel }: BarListProps) {
  const format = useFormat();
  if (items.length === 0) return <p className="text-muted">{empty}</p>;
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{renderLabel ? renderLabel(item) : item.label}</span>
            <span className="shrink-0 font-medium text-fg">{format.number(item.count)}</span>
          </div>
          <div className="h-1.5 rounded bg-surface-2" aria-hidden="true">
            <div
              className="h-full rounded bg-accent"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
